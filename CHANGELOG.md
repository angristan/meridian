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
