# Third-party notices and licensing inventory

Reviewed on 12 November 2026. Application source is covered by the [root MIT license](../LICENSE), copyright 2026 Yadnesh Salvi. Dependency licenses and external content retain their own notices. This inventory records actual files and declared metadata; it does not resolve missing permission or make a legal determination about a future distribution.

The frozen dependency lock SHA-256 is `2e0e254ff4cd8a6d6feb9f2399f7f2a66316fae31f9cae12498ba61ff64106ac`. [The local metadata inventory](licenses/LOCK_METADATA.json) records exact lock expressions, missing declarations, copied-notice hashes and inspected installed-artifact hashes. Platform-optional lock entries are not all installed or shipped together. The read-only release checker reports this metadata without assigning a license.

## Application assets and external content

WorldKit's product illustrations and synthesized test tones are original project material. No third-party product photography or identifiable participant footage is packaged by this implementation. Manufacturer documents, catalog content, user uploads and participant originals have separate source/permission/retention rules; the application MIT license does not grant rights to those materials. [Physical notebook provenance and permissions](PHYSICAL_NOTEBOOK.md) and [source-reading boundaries](SOURCE_READING.md).

## Bundled guarded payment core

The installed archive is `vendor/fracture-paypal-core-0.2.4.tgz`. Its `package/LICENSE` declares MIT, copyright 2026 Yadnesh Salvi; `package/PROVENANCE.json` records its SDK/source/conformance provenance. Both members are preserved unchanged as [the license](licenses/fracture-paypal-core-0.2.4-LICENSE.txt) and [the provenance](licenses/fracture-paypal-core-0.2.4-PROVENANCE.json).

The source also retains the earlier `0.2.3` archive, which is not the active dependency. Its [license](licenses/fracture-paypal-core-0.2.3-LICENSE.txt) and [provenance](licenses/fracture-paypal-core-0.2.3-PROVENANCE.json) are copied from that archive without alteration. The active tarball's SHA-512 must match `package-lock.json`; the checker verifies its bytes without executing or unpacking it.

The core's context-plugin package `paypal`, official PayPal Agent Toolkit and Toolkit's PayPal server SDK are separate dependencies with distinct identities. [The dependency review](DEPENDENCY_REVIEW.md) documents those identities and residual audit status. A common provider name does not transfer one package's license or compatibility to another.

## Fonts

`src/app/layout.tsx` selects Inter, Sora and JetBrains Mono through `next/font/google`. Their official Google Fonts OFL files were copied exactly from the sources below; copyright lines and the complete SIL Open Font License 1.1 text remain intact. These are notice copies, not a fingerprint of a newly built font bundle.

| Font | Preserved copyright | Official source | Local notice and SHA-256 |
| --- | --- | --- | --- |
| Inter | Copyright 2020 The Inter Project Authors | [Google Fonts Inter OFL](https://github.com/google/fonts/blob/main/ofl/inter/OFL.txt) | [Inter notice](licenses/inter-OFL.txt), `5b9321a4298cfeb6b34354164a1c3afc3db114569984c502b9b35d988fd58c57` |
| Sora | Copyright 2019 The Sora Project Authors | [Google Fonts Sora OFL](https://github.com/google/fonts/blob/main/ofl/sora/OFL.txt) | [Sora notice](licenses/sora-OFL.txt), `ba0b9729c9428ba79a0459ab8ec575791b51509dbec213e383d0316d37fec299` |
| JetBrains Mono | Copyright 2020 The JetBrains Mono Project Authors | [Google Fonts JetBrains Mono OFL](https://github.com/google/fonts/blob/main/ofl/jetbrainsmono/OFL.txt) | [JetBrains Mono notice](licenses/jetbrainsmono-OFL.txt), `b2fe5e8987594e9ffd1d2ca52a2f5d73eb8335243893c5d6254b5ad69269591d` |

[Font source receipts](licenses/FONT_SOURCES.json) include the official source/retrieval URLs, dates, exact byte counts and hashes.

## Declared non-MIT components and native artifacts

The lock declares MIT, Apache-2.0, BSD/ISC and other expressions, including 0BSD, MIT-0, BlueOak-1.0.0, Unlicense and compound choices. The exact expressions and counts are in the metadata inventory rather than being collapsed into the application's license.

| Component | Exact observed artifact and scope | Preserved declaration or notice |
| --- | --- | --- |
| `sharp@0.35.5` | Installed JavaScript image-processing package. Its own package declares Apache-2.0. | [Exact installed sharp license](licenses/sharp-0.35.5-LICENSE.txt). This file does not relabel its native dependencies. |
| `@img/sharp-libvips-darwin-arm64@1.3.4` | Inspected macOS ARM64 package includes `lib/libvips-cpp.8.18.7.dylib`, `versions.json` and its library-license README. Its manifest/lock declare LGPL-3.0-or-later. | [Exact installed library notice](licenses/sharp-libvips-darwin-arm64-1.3.4-NOTICE.md), including its component-specific license table; byte hashes are retained in the inventory. No standalone `LICENSE`/`COPYING` file was present in that inspected package. |
| Optional sharp/libvips platform packages | The lock contains libvips `1.3.4` platform variants with LGPL-3.0-or-later, sharp Windows `0.35.5` expressions containing Apache-2.0 and LGPL-3.0-or-later, and wasm `0.35.5` containing Apache-2.0, LGPL-3.0-or-later and MIT. | These declarations describe the locked variants. The release operator must inspect the exact selected runtime artifact and retain its applicable notices; macOS inspection does not qualify another platform's bundle. |
| `caniuse-lite@1.0.30001823` | Installed browser-compatibility data package; repository metadata names `browserslist/caniuse-lite` and author Ben Briggs. Its manifest and lock declare CC-BY-4.0. | [Exact installed CC-BY-4.0 license](licenses/caniuse-lite-1.0.30001823-LICENSE.txt). The component and declared authorship remain identified here. |

This source inventory does not determine that the notice, attribution or other conditions for every possible runtime/binary distribution have been met. Review the actual distribution and upstream notices at that release boundary. No dependency binaries were copied into this notice folder.

## Channel3: explicit licensing clarification gap

The installed `@channel3/sdk@4.9.0` manifest has **no license declaration** and no license/notice file was found in the inspected package. Its declared repository is `https://github.com/channel3-ai/channel3-ts-sdk`; the release owner's recorded check returned 404, and the [npm publisher page](https://www.npmjs.com/package/@channel3/sdk) displayed **License: none**. The local manifest hash is recorded in the metadata inventory. These observations do not establish redistribution permission or an open-source license.

External licensing clarification remains required before treating a distribution containing that SDK as licensed. No MIT grant is inferred from WorldKit's license, an absent field, an unavailable repository or account API access. The SDK remains pinned and its product features have not been removed or automatically relicensed by this review.

The application root also lacks a lockfile license field, so the checker reports that metadata omission. Its actual [checked-in MIT license](../LICENSE) remains explicit. This is separate from the unresolved upstream Channel3 declaration.

