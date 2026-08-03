## [1.12.3](https://github.com/angristan/meridian/compare/1.12.2...1.12.3) (2026-08-03)


### Bug Fixes

* repair verified revision identity metadata ([229bb70](https://github.com/angristan/meridian/commit/229bb701de3c83f404894eb372d906836ec860c0))

## [1.12.2](https://github.com/angristan/meridian/compare/1.12.1...1.12.2) (2026-08-03)


### Bug Fixes

* read legacy file operation IDs ([af37355](https://github.com/angristan/meridian/commit/af373557d5d0344ba0d2ab7f22043ee38b11d9ed))

## [1.12.1](https://github.com/angristan/meridian/compare/1.12.0...1.12.1) (2026-08-03)


### Bug Fixes

* repair missing local revision ancestry ([edfee26](https://github.com/angristan/meridian/commit/edfee2623d60bc4b7dea385f42d23d21e08d8131))

# [1.12.0](https://github.com/angristan/meridian/compare/1.11.13...1.12.0) (2026-08-03)


### Features

* simplify the plugin product surface ([0b480af](https://github.com/angristan/meridian/commit/0b480af0b1c198ebf6dc53ca8341b6f58bb8e215))

## [1.11.13](https://github.com/angristan/meridian/compare/1.11.12...1.11.13) (2026-08-03)


### Bug Fixes

* cancel pairing polls on unload ([fe1e9ef](https://github.com/angristan/meridian/commit/fe1e9efcd1af55035dcd8155a41541116fcdba1f))
* keep blob cleanup concurrent ([ca50b56](https://github.com/angristan/meridian/commit/ca50b561f20b5cd0362346a29f5a664ce8be4137))
* own vault events in sync lifecycle ([39220fe](https://github.com/angristan/meridian/commit/39220fe83d8e8ec8e8477926e1abe308c367522f))

## [1.11.12](https://github.com/angristan/meridian/compare/1.11.11...1.11.12) (2026-08-03)


### Bug Fixes

* preserve checkpoint-last durability ([e4cb163](https://github.com/angristan/meridian/commit/e4cb1638e144ea005585ebd916fce3e0701b3047))

## [1.11.11](https://github.com/angristan/meridian/compare/1.11.10...1.11.11) (2026-08-02)


### Bug Fixes

* recover interrupted blob cleanup ([c414504](https://github.com/angristan/meridian/commit/c41450484851ed2bab4941a23637febbf8dab9de))

## [1.11.10](https://github.com/angristan/meridian/compare/1.11.9...1.11.10) (2026-08-02)


### Bug Fixes

* fence sync maintenance races ([2f45620](https://github.com/angristan/meridian/commit/2f456209f5d3f7923c18e27a9a6c4378850a48d6))

## [1.11.9](https://github.com/angristan/meridian/compare/1.11.8...1.11.9) (2026-08-02)


### Performance Improvements

* reduce idle sync and transfer work ([06c0190](https://github.com/angristan/meridian/commit/06c0190123d69c8be0838c3fc33ff351816614d4))

## [1.11.8](https://github.com/angristan/meridian/compare/1.11.7...1.11.8) (2026-08-02)


### Performance Improvements

* reduce sync startup and index work ([e58d202](https://github.com/angristan/meridian/commit/e58d20209b4cb1eb3b5df0a47bbcab9ae96c0d8c))

## [1.11.7](https://github.com/angristan/meridian/compare/1.11.6...1.11.7) (2026-08-02)


### Performance Improvements

* reuse unchanged file fingerprints ([ef6f321](https://github.com/angristan/meridian/commit/ef6f3217a31112d47a68e93af3c6d2be9fdcb9e6))

## [1.11.6](https://github.com/angristan/meridian/compare/1.11.5...1.11.6) (2026-08-02)


### Bug Fixes

* bind queued revision operation IDs ([bc3af22](https://github.com/angristan/meridian/commit/bc3af225076b98a3efe9fd83f9aa3e9afa25b1e6))

## [1.11.5](https://github.com/angristan/meridian/compare/1.11.4...1.11.5) (2026-08-02)


### Bug Fixes

* resolve identical sync conflicts automatically ([a527b15](https://github.com/angristan/meridian/commit/a527b15a8a1e4157ab5c7bf91ca346c9de9c3ba5))

## [1.11.4](https://github.com/angristan/meridian/compare/1.11.3...1.11.4) (2026-08-02)


### Bug Fixes

* keep sync failures visible ([daf5827](https://github.com/angristan/meridian/commit/daf58271bf637eae9fa0fcddd7809d3c94c7883c))
* recover incomplete device certificate chains ([4a20b4b](https://github.com/angristan/meridian/commit/4a20b4b77a5f5875535afb7b94d5b9d8d05d4833))

## [1.11.3](https://github.com/angristan/meridian/compare/1.11.2...1.11.3) (2026-08-02)


### Bug Fixes

* repair paired device certificate chains ([2ff44d1](https://github.com/angristan/meridian/commit/2ff44d10e4d30025d2afac2644bd12550125959c))

## [1.11.2](https://github.com/angristan/meridian/compare/1.11.1...1.11.2) (2026-08-02)


### Bug Fixes

* remember last successful sync ([a879ba1](https://github.com/angristan/meridian/commit/a879ba1fd52c4978571c5cbf352934c7a4c5d236))

## [1.11.1](https://github.com/angristan/meridian/compare/1.11.0...1.11.1) (2026-08-02)


### Bug Fixes

* sync epoch transitions on offline devices ([4ae50ab](https://github.com/angristan/meridian/commit/4ae50ab0c21f4372467c438d5fd477066eaebc4c))

# [1.11.0](https://github.com/angristan/meridian/compare/1.10.0...1.11.0) (2026-08-01)


### Bug Fixes

* bound obsolete recovery receipts ([1416266](https://github.com/angristan/meridian/commit/1416266cb05d4da44d9204e7f9753648b10b3184))
* compact disposable sync records safely ([72ae32b](https://github.com/angristan/meridian/commit/72ae32ba268addfa99aa67374018a58e779ff0ca))
* fail closed under storage pressure ([402d758](https://github.com/angristan/meridian/commit/402d758959bcfe318e235c21880608122fc98dd3))


### Features

* enforce configurable storage quotas ([01c8759](https://github.com/angristan/meridian/commit/01c8759879931a98ee36be9f9e10ec64077ca007))
* track device retention acknowledgements ([a0176f6](https://github.com/angristan/meridian/commit/a0176f6997a679bb892435a039b9808c23790af4))

# [1.10.0](https://github.com/angristan/meridian/compare/1.9.0...1.10.0) (2026-08-01)


### Bug Fixes

* bind recovery state to epoch transitions ([4f2413c](https://github.com/angristan/meridian/commit/4f2413c997e64086e0d671aad96194df74803659))
* validate epoch rotation readiness ([61dd5b4](https://github.com/angristan/meridian/commit/61dd5b455895fa1c0980b93b344a104aa1f1ec01))


### Features

* define recoverable epoch transitions ([b4835e5](https://github.com/angristan/meridian/commit/b4835e568bb80723fa6c7ae24a10266814e69223))
* enforce authoritative key epochs ([3545fb1](https://github.com/angristan/meridian/commit/3545fb1680e0524104307713e89f247c3241cb30))
* rotate vault keys through sync ([6df64b0](https://github.com/angristan/meridian/commit/6df64b0f9fab6df62ac638f40c3a87ce6c335d21))

# [1.9.0](https://github.com/angristan/meridian/compare/1.8.0...1.9.0) (2026-08-01)


### Bug Fixes

* negotiate log format during rollout ([a279b70](https://github.com/angristan/meridian/commit/a279b70428fcc7eb90b19efd9a02f6e7c6d07f02))
* prevent stale recovery replacement ([f0a3a15](https://github.com/angristan/meridian/commit/f0a3a156b3df4b97e0c78b007137150ea0260382))
* reject protocol state substitution ([68f1ecd](https://github.com/angristan/meridian/commit/68f1ecd929271d4c2bb97ff437993d74ffa35c1d))
* upgrade compatible vaults automatically ([3bdbd0e](https://github.com/angristan/meridian/commit/3bdbd0e8bd70e81f8c53680c706ecaec2871dc3f))
* verify canonical operation log hashes ([30605c3](https://github.com/angristan/meridian/commit/30605c31492151cee4071b47a32e5223973b5fe1))
* version recovery claims explicitly ([d795087](https://github.com/angristan/meridian/commit/d795087fa3ae21ca9cea9dc2c320eb39a2ca8e8d))


### Features

* add owner-controlled log upgrade ([d931fb5](https://github.com/angristan/meridian/commit/d931fb549813d655e501f2c582906c7484e64ee5))
* define canonical log transitions ([909f839](https://github.com/angristan/meridian/commit/909f839e5e2bb169db324847bd989040d826e5d4))

# [1.8.0](https://github.com/angristan/meridian/compare/1.7.1...1.8.0) (2026-08-01)


### Bug Fixes

* preserve edits behind prepared retries ([d352493](https://github.com/angristan/meridian/commit/d352493409ad680eb6cd3da540b348bbc207cf61))


### Features

* persist coalesced vault changes ([f7c8f18](https://github.com/angristan/meridian/commit/f7c8f18548ecd9bc38d34c7ed31b12d726a7e2fb))


### Performance Improvements

* batch dirty event consumption ([e3a7346](https://github.com/angristan/meridian/commit/e3a7346a397b31226b6f9dbd2a963804581c4fd4))
* bound config discovery work ([53677a5](https://github.com/angristan/meridian/commit/53677a526ebb2da0e3526bd88569d48fb4ced2ef))
* cancel background scans cleanly ([e330965](https://github.com/angristan/meridian/commit/e33096547836f07bcbd718f2f8d946f64ab38000))
* move sync planning off the editor thread ([f2278cb](https://github.com/angristan/meridian/commit/f2278cb9225e8c45645ba669f60cd253d5c78bc1))
* reconcile only changed vault paths ([eed4ea0](https://github.com/angristan/meridian/commit/eed4ea03f600eb908af1d37b5c2e236d932c61ec))
* yield during large pull batches ([5b2b804](https://github.com/angristan/meridian/commit/5b2b804bf621eaec0a3ac760d3074cdbd00f2e48))

## [1.7.1](https://github.com/angristan/meridian/compare/1.7.0...1.7.1) (2026-07-31)


### Bug Fixes

* clean up revision history layout ([5159617](https://github.com/angristan/meridian/commit/51596170150147e4468ec48ebd0139af4324b7ef))

# [1.7.0](https://github.com/angristan/meridian/compare/1.6.6...1.7.0) (2026-07-31)


### Bug Fixes

* disable storage usage before setup ([081c7e3](https://github.com/angristan/meridian/commit/081c7e3cf00b46b765b56246f0d357d9beac4e56))
* expose sync actions accessibly ([94546e0](https://github.com/angristan/meridian/commit/94546e04b56fc1e95dd70ed18d954f6e5a3bffc7))
* inspect large history without blob limits ([068ef95](https://github.com/angristan/meridian/commit/068ef95b46f43c4bd3c860a2b9fbfd7cda3ba388))
* preserve path ownership during history restore ([86a6934](https://github.com/angristan/meridian/commit/86a69342aeed0c02318324bd3559d116e4c4af74))
* restore pause button affordance ([3161b3e](https://github.com/angristan/meridian/commit/3161b3eef221a6db41dcf920f945c36663f910c9))
* retain checkpoint signer authorization ([285bcbe](https://github.com/angristan/meridian/commit/285bcbe052af1481341bbca971e1fd65793ab2bb))
* verify remote operation log chains ([b8fc1b1](https://github.com/angristan/meridian/commit/b8fc1b1b7b1887a23b673f99b9fabb70d8d8377a))


### Features

* add native sync status menu ([1176672](https://github.com/angristan/meridian/commit/11766721c751e4895504dcd56bf519ab50678f14))
* add privacy-safe sync diagnostics ([5ed6e44](https://github.com/angristan/meridian/commit/5ed6e44617986b47f277cf0294392fdbce52bc3f))
* add searchable Obsidian settings ([726a1f1](https://github.com/angristan/meridian/commit/726a1f1888ba61c4192894728a684b10ee2555f8))
* add tombstone-safe selective sync ([d018b77](https://github.com/angristan/meridian/commit/d018b7785bc368846812ca72a533b09f641df41e))
* backfill complete authorized history ([2c20db8](https://github.com/angristan/meridian/commit/2c20db87c9422e5096b100b170718b2479cc94bd))
* guide safe conflict resolution ([76cd374](https://github.com/angristan/meridian/commit/76cd374651bb6825061453d33bdcf2796341d09a))
* preview and compare revision history ([843f486](https://github.com/angristan/meridian/commit/843f4868028183abd542d7969a490cc418941522))
* recover synchronized deleted files ([1e84d28](https://github.com/angristan/meridian/commit/1e84d28262f00fe785d97771198f3777c1e34891))
* retain revision activity metadata ([d545455](https://github.com/angristan/meridian/commit/d5454554ea973256a710d448a9a73a4234c34ddf))
* safely prune unreferenced uploads ([a3c9e30](https://github.com/angristan/meridian/commit/a3c9e30a43369bf35270fe07d36dd3dc6f8da11c))
* show safe storage retention status ([97f812b](https://github.com/angristan/meridian/commit/97f812bf28839b8e7f1aca225574cbb8c3c9a3ea))
* show synchronized activity ([0a4c061](https://github.com/angristan/meridian/commit/0a4c061e442d65653488fa06303d7fa44699e5e9))

## [1.6.6](https://github.com/angristan/meridian/compare/1.6.5...1.6.6) (2026-07-31)


### Bug Fixes

* streamline sync status view ([de66833](https://github.com/angristan/meridian/commit/de668338b471482c4eb6eae024e6d3280b2d453b))

## [1.6.5](https://github.com/angristan/meridian/compare/1.6.4...1.6.5) (2026-07-31)


### Bug Fixes

* compact sync status view ([35e72f4](https://github.com/angristan/meridian/commit/35e72f46154eea10f03b9c329ceec4479b5bede5))

## [1.6.4](https://github.com/angristan/meridian/compare/1.6.3...1.6.4) (2026-07-31)


### Bug Fixes

* keep sync progress layout stable ([4919705](https://github.com/angristan/meridian/commit/4919705ea7a11c013f235686b747695a92ac5af9))

## [1.6.3](https://github.com/angristan/meridian/compare/1.6.2...1.6.3) (2026-07-31)


### Bug Fixes

* preserve edits made during remote apply ([0b92a49](https://github.com/angristan/meridian/commit/0b92a49352751ea3b63243255352a814dd567d92))

## [1.6.2](https://github.com/angristan/meridian/compare/1.6.1...1.6.2) (2026-07-30)


### Performance Improvements

* avoid quadratic vault collision scans ([e32df5e](https://github.com/angristan/meridian/commit/e32df5eee3908dfc27f44beaa111f076196ede58))
* yield during large vault reconciliation ([d19a7c9](https://github.com/angristan/meridian/commit/d19a7c9ad6a3121c8ce3bb683a09a72c30ce2692))

## [1.6.1](https://github.com/angristan/meridian/compare/1.6.0...1.6.1) (2026-07-30)


### Bug Fixes

* admit maximum recovery claim bodies ([4259bb6](https://github.com/angristan/meridian/commit/4259bb6a795be348fa9757192e4149ab3afea3cb))
* apply case-only remote renames safely ([1691ebd](https://github.com/angristan/meridian/commit/1691ebd5d31050aa807009862dcc4eadd6b5bb70))
* authenticate remote file operation envelopes ([e22a3b9](https://github.com/angristan/meridian/commit/e22a3b9b0d78b208488bd310f5edf77992b78e85))
* bind recovery state to its public checkpoint ([e8bdedc](https://github.com/angristan/meridian/commit/e8bdedc5bb45a2e61a27c07f93e86d9653f003b7))
* bound streaming JSON body reads ([15656d7](https://github.com/angristan/meridian/commit/15656d73daedfa0eb66ab272f348672360b7c248))
* clear completed conflict retry payloads ([2ce6c10](https://github.com/angristan/meridian/commit/2ce6c10db8ec7c8c07c78014216d6687edb29f29))
* compare complete signed record replays ([bd31989](https://github.com/angristan/meridian/commit/bd319892287c5ee7ca8876928f50fb37b9d0a773))
* compute revision heads from every node ([1aed574](https://github.com/angristan/meridian/commit/1aed57499cc713bd2e35f9f123963527e399cb0d))
* consume committed cursors through ordered pulls ([beb2880](https://github.com/angristan/meridian/commit/beb28809d2191327ccd0abaf03b9f9a996dd143b))
* consume partial push commits before retrying ([fa90eab](https://github.com/angristan/meridian/commit/fa90eabb40a5afff711cd1b3235c9ea827ecdc56))
* enforce inbound revision size limits ([3a4e3f4](https://github.com/angristan/meridian/commit/3a4e3f41f40ae6c2685c24f0f019842a92a49dbd))
* enforce WebSocket session authorization continuously ([7eb93a6](https://github.com/angristan/meridian/commit/7eb93a6c47bdc4cfa10a4ebb166ab0bd60da37b5))
* parent local revisions from every DAG head ([6f5910a](https://github.com/angristan/meridian/commit/6f5910a3570a85712880978ccffec9144ab6c297))
* persist prepared revisions across commit retries ([9bb0c21](https://github.com/angristan/meridian/commit/9bb0c213cd1a069e5d8125e7074e05690951b08c))
* preserve durable work during index repair ([89df150](https://github.com/angristan/meridian/commit/89df1503d0f67b15901f9dd3e6ebe8246b5f2356))
* preserve locally disabled config categories ([1dcd767](https://github.com/angristan/meridian/commit/1dcd7677a06f9b1d3161cf3aec9a80192da880f9))
* preserve ownership of occupied paths ([e9ccaef](https://github.com/angristan/meridian/commit/e9ccaef60ff0fec8ab9982b854c9b893570322b3))
* prevent revoked device identity reuse ([dbca45e](https://github.com/angristan/meridian/commit/dbca45e6e3b15b042adfc421b82c4ff14db0ea26))
* prevent tombstones from deleting folders ([35163ee](https://github.com/angristan/meridian/commit/35163eef0806509aab492f4e1941b65bef95c3aa))
* provision a public Worker route by default ([2145caa](https://github.com/angristan/meridian/commit/2145caaef3ea55ee72a4844c964a47a39d780c5f))
* recheck record authors after verification ([8fe96e3](https://github.com/angristan/meridian/commit/8fe96e33e1262238721aa53895529693a59af6f7))
* reconcile local edits before notification pulls ([051881d](https://github.com/angristan/meridian/commit/051881dfeadd26565a3430b9011591ab5c437da4))
* reject conflicting pairing proof replays ([565d2aa](https://github.com/angristan/meridian/commit/565d2aac5837edc5ce6c3815ef2152f008f39a52))
* reject conflicting pairing release replays ([0d95b54](https://github.com/angristan/meridian/commit/0d95b54639cae35f6ef81a84846a05ba9faf72cc))
* reject invalid remote revision graphs ([40eac32](https://github.com/angristan/meridian/commit/40eac320244790fbfdb97ad4af4bf2f82fb76ec7))
* reject late-parent revision cycles ([1bbfcb9](https://github.com/angristan/meridian/commit/1bbfcb9419030005309e52794b4914add38d766b))
* reject non-canonical identity encodings ([40ca42f](https://github.com/angristan/meridian/commit/40ca42feeb6025bf5f70ca366d6d6f12e0874164))
* replay committed releases after expiry ([efe4bfc](https://github.com/angristan/meridian/commit/efe4bfc05375c78e87ed567c24555c3a2196d8f0))
* require epoch rotation permission during pairing ([7091af1](https://github.com/angristan/meridian/commit/7091af151e38ad3dc56697ea3a11c6d8f205b7e0))
* retry revocation socket closure on replays ([ead6351](https://github.com/angristan/meridian/commit/ead6351d0eac7d04f6966128044de6b16ec7f459))
* reuse outstanding public challenges ([6d11180](https://github.com/angristan/meridian/commit/6d1118046bb544197c650646fd850f077f84db58))
* revalidate expiring claims at commit time ([7e4d693](https://github.com/angristan/meridian/commit/7e4d693167fd5162642da8e1e2dc5da8ae57a1ac))
* revalidate pairing transitions after verification ([bcd34e4](https://github.com/angristan/meridian/commit/bcd34e458d6500b88fd9f46ea46cd256fe9487b9))
* revalidate setup identity at commit time ([a604cc2](https://github.com/angristan/meridian/commit/a604cc2092f59f7fe774321788369cd3fb7d31f3))
* serialize controller initialization ([925eee4](https://github.com/angristan/meridian/commit/925eee4edec92ed208158a80e8a467673e3176a9))
* validate serialized HPKE keypairs ([22aada4](https://github.com/angristan/meridian/commit/22aada41d83457d94674560800ac1d72548eaaaf))

# [1.6.0](https://github.com/angristan/meridian/compare/1.5.0...1.6.0) (2026-07-29)


### Features

* trace blob download streams ([466bd80](https://github.com/angristan/meridian/commit/466bd8029a027561564e91b6060cda0f96e61668))

# [1.5.0](https://github.com/angristan/meridian/compare/1.4.7...1.5.0) (2026-07-29)


### Features

* show live sync progress ([8782582](https://github.com/angristan/meridian/commit/8782582a877b69f00ee743e1b632b74a42314491))

## [1.4.7](https://github.com/angristan/meridian/compare/1.4.6...1.4.7) (2026-07-29)


### Bug Fixes

* expose sync controls in status view ([726eeba](https://github.com/angristan/meridian/commit/726eebae10c11f4a5e71cf54963942a379ea5ebe))

## [1.4.6](https://github.com/angristan/meridian/compare/1.4.5...1.4.6) (2026-07-27)


### Bug Fixes

* handle abnormal websocket closures ([1be75ae](https://github.com/angristan/meridian/commit/1be75ae87f6eb5f33ab0b3d6c6e6a919b5d587df))

## [1.4.5](https://github.com/angristan/meridian/compare/1.4.4...1.4.5) (2026-07-27)


### Bug Fixes

* batch rapid file edits ([6459061](https://github.com/angristan/meridian/commit/64590616c8d8da7a26a24aff3f5a9e2e34407c2f))

## [1.4.4](https://github.com/angristan/meridian/compare/1.4.3...1.4.4) (2026-07-27)


### Bug Fixes

* reduce sync request amplification ([d6c38f1](https://github.com/angristan/meridian/commit/d6c38f143986b848c010a0501e5643178e93e735))

## [1.4.3](https://github.com/angristan/meridian/compare/1.4.2...1.4.3) (2026-07-27)


### Bug Fixes

* clarify pairing device review ([12c8d9a](https://github.com/angristan/meridian/commit/12c8d9aaf94756898daebcd91dc9f75ddb2f16f2))

## [1.4.2](https://github.com/angristan/meridian/compare/1.4.1...1.4.2) (2026-07-27)


### Bug Fixes

* build exact pairing certificate chain ([5cad3a3](https://github.com/angristan/meridian/commit/5cad3a3b08b14bd9c4a63298998743baa662627e))

## [1.4.1](https://github.com/angristan/meridian/compare/1.4.0...1.4.1) (2026-07-27)


### Bug Fixes

* make device pairing safely retryable ([5e0c667](https://github.com/angristan/meridian/commit/5e0c667ebb028356d13734e380db43e691778a1d))

# [1.4.0](https://github.com/angristan/meridian/compare/1.3.0...1.4.0) (2026-07-26)


### Features

* add safe device self-removal ([3746508](https://github.com/angristan/meridian/commit/3746508b7e1dbf6f491737e2d98e8d6146b3f674))

# [1.3.0](https://github.com/angristan/meridian/compare/1.2.0...1.3.0) (2026-07-26)


### Features

* add device revocation controls ([4dd711a](https://github.com/angristan/meridian/commit/4dd711a90b7c00a8d348e213e796ccf3b9556509))

# [1.2.0](https://github.com/angristan/meridian/compare/1.1.3...1.2.0) (2026-07-25)


### Features

* improve secure device pairing ([8a99730](https://github.com/angristan/meridian/commit/8a99730b5f4106cc52ebff7084152a96da9f9b42))

## [1.1.3](https://github.com/angristan/meridian/compare/1.1.2...1.1.3) (2026-07-25)


### Bug Fixes

* generate protocol-sized pairing IDs ([4a14042](https://github.com/angristan/meridian/commit/4a14042b357593d5c7f00a4ee713321411637d6c))

## [1.1.2](https://github.com/angristan/meridian/compare/1.1.1...1.1.2) (2026-07-25)


### Bug Fixes

* namespace pairing URI parameters ([6c656f6](https://github.com/angristan/meridian/commit/6c656f614e986cb83d8bffbb5a034f1006ee1147))

## [1.1.1](https://github.com/angristan/meridian/compare/1.1.0...1.1.1) (2026-07-25)


### Bug Fixes

* avoid reserved vault pairing parameter ([a2ef7c6](https://github.com/angristan/meridian/commit/a2ef7c6dd90a3bcfec9608965b32e234f88aad7c))

# [1.1.0](https://github.com/angristan/meridian/compare/1.0.0...1.1.0) (2026-07-25)


### Features

* add one-scan device pairing ([afafafc](https://github.com/angristan/meridian/commit/afafafcc79dbd85f1208e5c93af14f74a78ab221))

# 1.0.0 (2026-07-25)


### Bug Fixes

* handle empty blob responses ([660e0bc](https://github.com/angristan/meridian/commit/660e0bc690e46e5e7a84ac3ed8d236e555badd7d))
* make plugin packaging portable ([5cca210](https://github.com/angristan/meridian/commit/5cca2106bf1d51cc57368824200ab76bd499db6d))
* mask recovery codes by default ([65bff96](https://github.com/angristan/meridian/commit/65bff96e681269172598918c3b56070d13ccca37))


### Features

* implement Meridian ([cf52cb5](https://github.com/angristan/meridian/commit/cf52cb5d9e0576eb1189656ac21a87e05b084cb8))
