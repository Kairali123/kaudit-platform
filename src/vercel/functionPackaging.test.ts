import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { posix } from 'node:path'

/**
 * Packaging contract for the Vercel Node Function.
 *
 * `src/vercel/deploymentContract.test.ts` covers *what* the function is allowed
 * to do. This file covers something narrower and just as deployable-breaking:
 * whether the files it needs at runtime are actually inside the serverless
 * output.
 *
 * The failure this exists to catch is silent at build time. `vercel.json`
 * declared `includeFiles: "apps/web/dist/**"`, so the built web assets shipped
 * and the deployment reported Ready — but `api/index.ts` imports
 * `../src/vercel/dashboardFunction.ts`, and no glob covered `src/`. Every
 * invocation then died with `ERR_MODULE_NOT_FOUND` on a `.ts` path under
 * `/var/task`, before a single line of the application ran. A Ready build is
 * therefore not evidence that the function can start.
 *
 * The check is a static walk of the entry point's import graph, compared
 * against the `includeFiles` globs. That is deterministic and offline: it reads
 * repository files and nothing else. No deployment, no project link, no
 * credential, no environment variable, no socket, and no module is executed —
 * importing the graph for real would construct a runtime, which is exactly what
 * a packaging test must not do.
 *
 * The graph is deliberately a superset: `import type` specifiers are erased
 * before Node ever loads a file, but counting them only widens what must be
 * packaged, and erring toward packaging a file cannot break a deployment.
 */

const ROOT = new URL('../../', import.meta.url)

/** The Vercel Function entry point, as `vercel.json` names it. */
const ENTRY = 'api/index.ts'

const VERCEL = JSON.parse(read('vercel.json')) as {
  functions?: Record<string, { includeFiles?: string }>
}
const PACKAGE = JSON.parse(read('package.json')) as {
  dependencies?: Record<string, string>
}

function read(relativePath: string): string {
  return readFileSync(new URL(relativePath, ROOT), 'utf8')
}

function exists(relativePath: string): boolean {
  return existsSync(new URL(relativePath, ROOT))
}

/** Comments explain a rule; only executable text can enforce it. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

// ---------------------------------------------------------------------------
// includeFiles globs
// ---------------------------------------------------------------------------

/**
 * Translates one `includeFiles` glob into the match test Vercel's packaging
 * step performs, limited to the three constructs this repository uses: brace
 * alternation, `**` across path separators, and `*` within one segment.
 */
function globToRegExp(glob: string): RegExp {
  let pattern = ''
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index]
    if (character === '{') {
      const close = glob.indexOf('}', index)
      assert.notEqual(close, -1, `unterminated brace group in glob: ${glob}`)
      const alternatives = glob.slice(index + 1, close).split(',')
      assert.equal(
        alternatives.some((alternative) => /[{}]/.test(alternative)),
        false,
        `nested brace groups are not supported by this test: ${glob}`,
      )
      pattern += `(?:${alternatives.map(escapeLiteral).join('|')})`
      index = close
    } else if (character === '*') {
      if (glob[index + 1] === '*') {
        // `dir/**` matches the directory's whole subtree, at any depth.
        pattern += '.*'
        index += 1
      } else {
        pattern += '[^/]*'
      }
    } else {
      pattern += escapeLiteral(character)
    }
  }
  return new RegExp(`^${pattern}$`)
}

function escapeLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function includeGlobs(): readonly string[] {
  const configured = VERCEL.functions?.[ENTRY]?.includeFiles
  assert.equal(
    typeof configured,
    'string',
    `vercel.json must declare includeFiles for ${ENTRY}`,
  )
  return [String(configured)]
}

const INCLUDE_MATCHERS = includeGlobs().map(globToRegExp)

function isPackaged(repositoryPath: string): boolean {
  return INCLUDE_MATCHERS.some((matcher) => matcher.test(repositoryPath))
}

// ---------------------------------------------------------------------------
// The entry point's runtime import graph
// ---------------------------------------------------------------------------

interface RuntimeGraph {
  /** Repository-relative paths, entry point included, sorted. */
  files: readonly string[]
  /** Bare specifiers — packages that must come from `dependencies`. */
  packages: readonly string[]
}

/**
 * Every specifier form the repository uses: `import`/`export … from`, a
 * side-effect `import`, and a dynamic `import()` of a literal.
 */
const SPECIFIER_PATTERNS = [
  /\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bimport\s+['"]([^'"]+)['"]/g,
]

function collectRuntimeGraph(entry: string): RuntimeGraph {
  const files = new Set<string>()
  const packages = new Set<string>()
  const pending = [entry]

  while (pending.length > 0) {
    const file = pending.pop() as string
    if (files.has(file)) continue
    files.add(file)

    const source = code(read(file))
    for (const pattern of SPECIFIER_PATTERNS) {
      for (const match of source.matchAll(pattern)) {
        const specifier = match[1]
        if (specifier === undefined) continue
        if (specifier.startsWith('node:')) continue
        if (!specifier.startsWith('.')) {
          packages.add(specifier)
          continue
        }
        const target = posix.normalize(
          posix.join(posix.dirname(file), specifier),
        )
        assert.ok(
          exists(target),
          `${file} imports ${specifier}, which does not exist in the repository`,
        )
        pending.push(target)
      }
    }
  }

  return {
    files: [...files].sort(),
    packages: [...packages].sort(),
  }
}

const GRAPH = collectRuntimeGraph(ENTRY)

// ---------------------------------------------------------------------------
// What the function must contain
// ---------------------------------------------------------------------------

test('the entry point reaches a non-trivial runtime graph', () => {
  // A scanner that silently stopped at the first file would make every other
  // assertion here vacuous.
  assert.ok(
    GRAPH.files.length > 10,
    `expected the entry point to reach the application, found ${GRAPH.files.length} files`,
  )
  assert.ok(GRAPH.files.includes('src/vercel/dashboardFunction.ts'))
  assert.ok(GRAPH.files.includes('src/runtime/dashboardRuntime.ts'))
})

test('every file the entry point imports is packaged with the function', () => {
  // The regression. Imports keep their `.ts` specifier — that is how the whole
  // repository runs under Node's type stripping — so these exact paths must be
  // present in the serverless output, not a compiled variant of them.
  const unpackaged = GRAPH.files.filter(
    (file) => file !== ENTRY && !isPackaged(file),
  )
  assert.deepEqual(
    unpackaged,
    [],
    `includeFiles does not cover these runtime files: ${unpackaged.join(', ')}`,
  )
})

test('the built web files the function serves stay packaged', () => {
  // Widening the glob for `src/` must not drop the web output: nothing but the
  // hashed `/assets/` prefix is routed statically, so the function itself
  // serves the SPA shell from the build directory.
  assert.ok(isPackaged('apps/web/dist/index.html'))
  assert.ok(isPackaged('apps/web/dist/assets/index-00000000.js'))
})

test('the packages the entry point reaches are runtime dependencies', () => {
  // A runtime import resolved only by `devDependencies` is the same class of
  // failure with a different message: the build succeeds and the invocation
  // cannot resolve the module.
  const dependencies = PACKAGE.dependencies ?? {}
  for (const specifier of GRAPH.packages) {
    const packageName = specifier.startsWith('@')
      ? specifier.split('/').slice(0, 2).join('/')
      : (specifier.split('/')[0] as string)
    assert.ok(
      packageName in dependencies,
      `${packageName} is imported by the function but is not a runtime dependency`,
    )
  }
})

// ---------------------------------------------------------------------------
// What the function must not contain
// ---------------------------------------------------------------------------

test('the runtime graph stays inside the application source', () => {
  // Migrations, operator CLIs' fixtures, and scripts are not part of a web
  // deployment. If the graph ever reaches outside these directories, the
  // packaging glob is the wrong question to be asking.
  for (const file of GRAPH.files) {
    assert.ok(
      file === ENTRY || file.startsWith('src/'),
      `${file} is outside src/ but is imported by the Vercel function`,
    )
  }
})

test('the packaging glob draws in no secret, dependency tree, or fixture', () => {
  // `includeFiles` is a copy instruction. A glob that reached any of these
  // would place them inside the deployed function image.
  for (const forbidden of [
    '.env',
    '.env.local',
    '.env.example',
    '.vercel/production.env',
    'node_modules/mysql2/index.js',
    'test-fixtures/sample.json',
    'migrations/001_init.sql',
  ]) {
    assert.equal(
      isPackaged(forbidden),
      false,
      `includeFiles must not package ${forbidden}`,
    )
  }
})
