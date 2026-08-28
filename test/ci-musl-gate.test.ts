import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The musl (Alpine) binary is a SHIPPED artifact whose native differs from every
 * other platform's: `pty.node` is embedded at compile time and node-pty has no
 * linux prebuild, so it is compiled against whatever libc the builder runs on. A
 * glibc native inside a musl binary builds cleanly and fails only when the native
 * is dlopen'd — on the user's machine.
 *
 * That artifact was originally gated ONLY in release.yml, which runs on tag push.
 * So a PR could change the build script, the embed plugin, or node-pty's version
 * and the musl leg was first exercised during a release, after npm had published.
 * ci.yml now carries a musl job too.
 *
 * WHAT THESE TESTS DEFEND: not the YAML's shape, but the claim "the PR gate is not
 * weaker than the release gate for musl". Every assertion below corresponds to a
 * step whose removal would leave CI green while silently un-gating musl:
 *   • no musl job at all              → back to release-only discovery
 *   • builds a non-musl target        → gates the wrong artifact
 *   • no readelf linkage check        → a glibc native ships inside a musl binary
 *   • no smoke run                    → compiles but never executes it (and the
 *     smoke run is what proves the native LOADS — see the dlopen note below)
 *
 * Deliberately parsed as text rather than YAML: the assertions are about specific
 * commands being present, and a text match cannot be satisfied by a structurally
 * valid file that runs something else.
 */

const CI = readFileSync(resolve(import.meta.dirname, '../.github/workflows/ci.yml'), 'utf-8');
const RELEASE = readFileSync(resolve(import.meta.dirname, '../.github/workflows/release.yml'), 'utf-8');

/** Strip `#` comments so a claim can never be satisfied by prose ABOUT the claim.
 *  (A comment mentioning `--target bun-linux-x64-musl` would otherwise pass an
 *  assertion that the job actually builds that target.) */
const stripComments = (yaml: string) => yaml
  .split('\n')
  .map((line) => line.replace(/(^|\s)#.*$/, '$1'))
  .join('\n');

const CI_CODE = stripComments(CI);
const RELEASE_CODE = stripComments(RELEASE);

describe('ci.yml — the musl artifact is gated on PRs, not only at release', () => {
  it('defines a musl binary job', () => {
    expect(CI_CODE).toMatch(/^ {2}bun-binary-musl:/m);
  });

  it('runs that job in a musl container (GitHub has no Alpine runner)', () => {
    // Without a musl container the job would compile on glibc and prove nothing:
    // the native is whatever libc the builder has.
    expect(CI_CODE).toMatch(/container:\s*node:22-alpine/);
  });

  it('compiles the musl TARGET (not the glibc one it sits next to)', () => {
    expect(CI_CODE).toContain('--target bun-linux-x64-musl');
  });

  it('asserts the native is musl-linked before compiling around it', () => {
    // The fail-closed readelf gate. A glibc `pty.node` embedded in a musl binary
    // survives the build; this is the only cheap place it is unambiguous.
    expect(CI_CODE).toMatch(/readelf -d .*grep -q 'libc\\\.musl'/);
  });

  it('EXECUTES the musl binary through the shared smoke script', () => {
    // Running it is what proves the embedded native loads: dist/cli.js statically
    // imports node-pty (via the backends) and node-pty dlopens the native at
    // MODULE scope. Verified by mutation — corrupting the embedded pty.node makes
    // the smoke script die on its FIRST check with ERR_DLOPEN_FAILED, before any
    // check passes. So "the binary ran at all" already covers dlopen.
    expect(CI_CODE).toMatch(/node scripts\/smoke-bun-binary\.mjs dist-bin\/botmux-linux-x64-musl/);
  });

  it('uses the SAME smoke script as the release musl leg (no weaker PR gate)', () => {
    // Parity is the actual invariant. If the release leg ever moves to a stronger
    // script, this catches a PR gate left behind on the old one.
    expect(RELEASE_CODE).toContain('scripts/smoke-bun-binary.mjs');
    expect(CI_CODE).toContain('scripts/smoke-bun-binary.mjs');
  });

  it('stamps a version BEFORE compiling (or the smoke version check cannot pass)', () => {
    // Compiled mode has no package.json on disk, so the version is baked at build
    // time; the repo's 0.0.0 placeholder is treated as "nothing baked" and yields
    // the `unknown` sentinel the smoke script rejects. Order matters: `npm version`
    // must also come AFTER `bun install`, since --frozen-lockfile must see the
    // committed package.json.
    const job = CI_CODE.slice(CI_CODE.indexOf('bun-binary-musl:'));
    const install = job.indexOf('bun install --frozen-lockfile');
    const version = job.indexOf('npm version');
    const compile = job.indexOf('--target bun-linux-x64-musl');
    expect(install).toBeGreaterThan(-1);
    expect(version).toBeGreaterThan(install);
    expect(compile).toBeGreaterThan(version);
  });
});

describe('release.yml — the musl legs stay wired into the publish chain', () => {
  it('still builds BOTH musl arches (ci.yml only canaries x64)', () => {
    // The PR gate deliberately covers one arch (arm64 needs a separate, slower
    // runner). The release must not quietly shrink to match it.
    expect(RELEASE_CODE).toContain('bun-linux-x64-musl');
    expect(RELEASE_CODE).toContain('bun-linux-arm64-musl');
  });

  it('gates the publish jobs on the musl job (else musl subpackages ship unbuilt)', () => {
    // `binary-subpackages` packs the artifacts into npm tarballs. If it does not
    // need the musl job, a musl subpackage could publish without its binary —
    // and npm treats a missing optional dep as a silent no-op.
    const subpackages = RELEASE_CODE.slice(RELEASE_CODE.indexOf('binary-subpackages:'));
    const needsLine = subpackages.slice(0, subpackages.indexOf('runs-on'));
    expect(needsLine).toContain('bun-binaries-musl');
  });
});
