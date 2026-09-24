# Changelog

## [0.6.2](https://github.com/AksharP5/cohall/compare/v0.6.1...v0.6.2) (2026-09-24)


### Bug Fixes

* **bot:** retain cancellation limits after uncertain dispatch ([#81](https://github.com/AksharP5/cohall/issues/81)) ([e324530](https://github.com/AksharP5/cohall/commit/e324530ee578bae7fd5a244a70daffa4304d8eb7))
* **cli:** reject invalid timeouts before sending work ([#70](https://github.com/AksharP5/cohall/issues/70)) ([bac67e9](https://github.com/AksharP5/cohall/commit/bac67e9a2dc8c9c460f2b5df7b882d098177c5ae))
* **config:** reject files as workspace roots ([#75](https://github.com/AksharP5/cohall/issues/75)) ([7b86305](https://github.com/AksharP5/cohall/commit/7b86305f36f68d264441c0d09fabbcbc23f457ae))
* **delegation:** keep child tasks out of blocked parent slots ([#80](https://github.com/AksharP5/cohall/issues/80)) ([5b1e891](https://github.com/AksharP5/cohall/commit/5b1e891244c913d752b98015a28f30d6dd9b237a))
* **deps:** update packages with published advisories ([#77](https://github.com/AksharP5/cohall/issues/77)) ([10801c9](https://github.com/AksharP5/cohall/commit/10801c9bc620b61da73b33480628ece4e0d1b583))
* **pairing:** track the source of worker requests ([#79](https://github.com/AksharP5/cohall/issues/79)) ([5f383c6](https://github.com/AksharP5/cohall/commit/5f383c6ec8c5068417fcb7bdd915aed4976e71dc))
* **provider:** finish cancellation before releasing the worker ([#74](https://github.com/AksharP5/cohall/issues/74)) ([a4ff068](https://github.com/AksharP5/cohall/commit/a4ff0684be9d1fbbc543d141537f2d0d5232559d))
* **relay:** isolate failed device connections ([#72](https://github.com/AksharP5/cohall/issues/72)) ([035868d](https://github.com/AksharP5/cohall/commit/035868d72fcf5894ff8dcf71407951522bf66d1c))
* **service:** retain the configured file and Node runtime ([#73](https://github.com/AksharP5/cohall/issues/73)) ([9811d1b](https://github.com/AksharP5/cohall/commit/9811d1b83bc9e8249f7f514c200967e110f7befc))
* **tasks:** preserve continuity after reconnects ([#76](https://github.com/AksharP5/cohall/issues/76)) ([3b22717](https://github.com/AksharP5/cohall/commit/3b2271726316d6b6364fda3a8adbecaf69149342))
* **windows:** launch providers, upgrades, and background workers reliably ([#78](https://github.com/AksharP5/cohall/issues/78)) ([6ccc4f8](https://github.com/AksharP5/cohall/commit/6ccc4f89550dcb22449d3035daa96af716c2558e))

## [0.6.1](https://github.com/AksharP5/cohall/compare/v0.6.0...v0.6.1) (2026-09-23)


### Bug Fixes

* **bot:** release rejected tasks without waiting six hours ([#67](https://github.com/AksharP5/cohall/issues/67)) ([e0d7a06](https://github.com/AksharP5/cohall/commit/e0d7a06545095c1fc52473b90cbff962dff2fd67))
* **upgrade:** preserve recovery state and resolve trusted tools ([#66](https://github.com/AksharP5/cohall/issues/66)) ([bccfb18](https://github.com/AksharP5/cohall/commit/bccfb18ccc278fdbc1caede52bdeb70f56d16d81))

## [0.6.0](https://github.com/AksharP5/cohall/compare/v0.5.6...v0.6.0) (2026-09-23)


### Features

* message Grok Bots across devices ([#64](https://github.com/AksharP5/cohall/issues/64)) ([377ef7c](https://github.com/AksharP5/cohall/commit/377ef7ce3514446c5262fac2f76bebf15405bbe9))

## [0.5.6](https://github.com/AksharP5/cohall/compare/v0.5.5...v0.5.6) (2026-08-13)


### Bug Fixes

* **provider:** pass OpenCode prompt before files ([#62](https://github.com/AksharP5/cohall/issues/62)) ([d4a7cd7](https://github.com/AksharP5/cohall/commit/d4a7cd713ef1fb450967c6e746bb221d7edaf5a0))

## [0.5.5](https://github.com/AksharP5/cohall/compare/v0.5.4...v0.5.5) (2026-08-13)


### Bug Fixes

* **provider:** keep OpenCode delegation reliable ([#60](https://github.com/AksharP5/cohall/issues/60)) ([ebc1980](https://github.com/AksharP5/cohall/commit/ebc19801969472e10aa44e44205117b7e6088d57))

## [0.5.4](https://github.com/AksharP5/cohall/compare/v0.5.3...v0.5.4) (2026-08-11)


### Bug Fixes

* **provider:** keep tasks alive after oversized events ([#58](https://github.com/AksharP5/cohall/issues/58)) ([ac401a2](https://github.com/AksharP5/cohall/commit/ac401a2c471d3addd1bbbbd0ff97a452990f7e02))

## [0.5.3](https://github.com/AksharP5/cohall/compare/v0.5.2...v0.5.3) (2026-08-10)


### Bug Fixes

* **device:** trust distro-packaged npm ([#56](https://github.com/AksharP5/cohall/issues/56)) ([60de35d](https://github.com/AksharP5/cohall/commit/60de35dff54847b221f46cd89744cd0acef732a9))

## [0.5.2](https://github.com/AksharP5/cohall/compare/v0.5.1...v0.5.2) (2026-08-10)


### Bug Fixes

* **device:** support confined and Homebrew upgrades ([#54](https://github.com/AksharP5/cohall/issues/54)) ([80759fd](https://github.com/AksharP5/cohall/commit/80759fdaefa03fd8f6c7b6fd0a3f72b09c3b3d39))

## [0.5.1](https://github.com/AksharP5/cohall/compare/v0.5.0...v0.5.1) (2026-08-10)


### Bug Fixes

* **relay:** reject upgrades for legacy daemons ([#52](https://github.com/AksharP5/cohall/issues/52)) ([d4ab660](https://github.com/AksharP5/cohall/commit/d4ab660cce5489f6f572e221e71fc4ff6a412287))

## [0.5.0](https://github.com/AksharP5/cohall/compare/v0.4.10...v0.5.0) (2026-08-10)


### Features

* add safe all-device operations ([#47](https://github.com/AksharP5/cohall/issues/47)) ([34da34f](https://github.com/AksharP5/cohall/commit/34da34fd57cbde624f6c9f2dc171a2644a84faf0))
* **cli:** make device setup guided ([#44](https://github.com/AksharP5/cohall/issues/44)) ([0330094](https://github.com/AksharP5/cohall/commit/033009416a97d6158af978589de92f77b4d1c3b7))
* **relay:** make relay moves recoverable ([#46](https://github.com/AksharP5/cohall/issues/46)) ([851ddff](https://github.com/AksharP5/cohall/commit/851ddff4dcd8545477b729c8f5509a3b145fd759))


### Bug Fixes

* **device:** trust service manager executables ([#50](https://github.com/AksharP5/cohall/issues/50)) ([f150574](https://github.com/AksharP5/cohall/commit/f1505743621647e3ff8f239f2ebd6b11c9a9c09a))
* **relay:** harden relay moves ([#48](https://github.com/AksharP5/cohall/issues/48)) ([fd8c8f3](https://github.com/AksharP5/cohall/commit/fd8c8f3f5d4a14deace8c82e3bcb043f33968127))
* **relay:** make all-device maintenance recoverable ([#49](https://github.com/AksharP5/cohall/issues/49)) ([63fd304](https://github.com/AksharP5/cohall/commit/63fd304fe6c81c4d71122afe2bc2ca8899b0e117))

## [0.4.10](https://github.com/AksharP5/cohall/compare/v0.4.9...v0.4.10) (2026-08-09)


### Bug Fixes

* **device:** preserve macOS provider startup ([#42](https://github.com/AksharP5/cohall/issues/42)) ([aef9f0d](https://github.com/AksharP5/cohall/commit/aef9f0db5ff2360e6bf38774d6b3350804b46f0e))

## [0.4.9](https://github.com/AksharP5/cohall/compare/v0.4.8...v0.4.9) (2026-08-09)


### Bug Fixes

* harden cross-device runtime boundaries ([#40](https://github.com/AksharP5/cohall/issues/40)) ([8f0090d](https://github.com/AksharP5/cohall/commit/8f0090d42edc7067ad695eb378d2f8810ea126d7))

## [0.4.8](https://github.com/AksharP5/cohall/compare/v0.4.7...v0.4.8) (2026-08-09)


### Bug Fixes

* **docs:** make public onboarding concise and private-safe ([#38](https://github.com/AksharP5/cohall/issues/38)) ([d9bdd8a](https://github.com/AksharP5/cohall/commit/d9bdd8a6b866e3cc659a71c464b3c0580d272dec))

## [0.4.7](https://github.com/AksharP5/cohall/compare/v0.4.6...v0.4.7) (2026-08-09)


### Bug Fixes

* **skill:** carry conversation context into handoffs ([#36](https://github.com/AksharP5/cohall/issues/36)) ([f96382f](https://github.com/AksharP5/cohall/commit/f96382ff2385b3825307cbf838dd3e805ce27d8b))

## [0.4.6](https://github.com/AksharP5/cohall/compare/v0.4.5...v0.4.6) (2026-08-08)


### Bug Fixes

* **skill:** explain cross-device workflows and recovery ([#34](https://github.com/AksharP5/cohall/issues/34)) ([0bba7b9](https://github.com/AksharP5/cohall/commit/0bba7b9645d2c1f577332ebb21a885b973fc6e80))

## [0.4.5](https://github.com/AksharP5/cohall/compare/v0.4.4...v0.4.5) (2026-08-07)


### Bug Fixes

* **relay:** keep upgrades available and forget stale devices ([#32](https://github.com/AksharP5/cohall/issues/32)) ([d5b054d](https://github.com/AksharP5/cohall/commit/d5b054db37b8e2737af7540cac4f74f64e457a7f))

## [0.4.4](https://github.com/AksharP5/cohall/compare/v0.4.3...v0.4.4) (2026-08-07)


### Bug Fixes

* **upgrade:** retain delegated restart receipts ([2c7e9c7](https://github.com/AksharP5/cohall/commit/2c7e9c713baff421c21f3780991f9ffcb0536d1d))

## [0.4.3](https://github.com/AksharP5/cohall/compare/v0.4.2...v0.4.3) (2026-08-07)


### Bug Fixes

* **upgrade:** persist self-restart progress ([b06ae1a](https://github.com/AksharP5/cohall/commit/b06ae1a4ed1ac467f44e118e630e78fca5a9aadb))

## [0.4.2](https://github.com/AksharP5/cohall/compare/v0.4.1...v0.4.2) (2026-08-07)


### Bug Fixes

* **upgrade:** detect service installation mismatches ([19bf066](https://github.com/AksharP5/cohall/commit/19bf06674d6fac87576f804e92d863d5c673dda0))

## [0.4.1](https://github.com/AksharP5/cohall/compare/v0.4.0...v0.4.1) (2026-08-07)


### Bug Fixes

* **device:** bound relay message buffering ([15b975e](https://github.com/AksharP5/cohall/commit/15b975eb658ac8b1140ed0481ab4726543265ca4))
* **providers:** bound JSON events while streaming ([7e0a4fc](https://github.com/AksharP5/cohall/commit/7e0a4fccc1b68e630b0b8bb553bbb66b84795798))
* **providers:** preserve custom config for nested delegation ([#21](https://github.com/AksharP5/cohall/issues/21)) ([63c95f8](https://github.com/AksharP5/cohall/commit/63c95f84f00ad03ad8d017696a5a87cbb8c6c05d))
* **upgrade:** restart already-current services ([a2c775f](https://github.com/AksharP5/cohall/commit/a2c775fe48a4dffda54ea7537f34b1a2b6d1e6ed))

## [0.4.0](https://github.com/AksharP5/cohall/compare/v0.3.4...v0.4.0) (2026-08-07)


### Features

* **cli:** upgrade Cohall and restart managed services ([#17](https://github.com/AksharP5/cohall/issues/17)) ([b366eff](https://github.com/AksharP5/cohall/commit/b366eff03d6e57d41bcb4a799f49211408f160d2))


### Bug Fixes

* **providers:** keep OpenCode prompts out of process arguments ([#20](https://github.com/AksharP5/cohall/issues/20)) ([30e0756](https://github.com/AksharP5/cohall/commit/30e07563acb197940274e5eb6a0a442048c1a9dd))
* **security:** keep credentials scoped to their relay ([#19](https://github.com/AksharP5/cohall/issues/19)) ([25a0973](https://github.com/AksharP5/cohall/commit/25a0973bde1d658c6f9ffa8d4fb5c0696b2f94db))

## [0.3.4](https://github.com/AksharP5/cohall/compare/v0.3.3...v0.3.4) (2026-08-06)


### Bug Fixes

* stream large provider event output ([565259a](https://github.com/AksharP5/cohall/commit/565259a59e45257785958fbc8430bcbfd30606a1))

## [0.3.3](https://github.com/AksharP5/cohall/compare/v0.3.2...v0.3.3) (2026-08-06)


### Bug Fixes

* patch MCP dependencies and release runtime ([#13](https://github.com/AksharP5/cohall/issues/13)) ([4155c00](https://github.com/AksharP5/cohall/commit/4155c00583cbe71e0afd85cc0438085dbdfa546c))

## [0.3.2](https://github.com/AksharP5/cohall/compare/v0.3.1...v0.3.2) (2026-08-06)


### Bug Fixes

* make setup and provider diagnostics reliable ([#11](https://github.com/AksharP5/cohall/issues/11)) ([3c621c7](https://github.com/AksharP5/cohall/commit/3c621c7b2c13ba192ced7d93319cc41df3af256e))

## [0.3.1](https://github.com/AksharP5/cohall/compare/v0.3.0...v0.3.1) (2026-08-06)


### Bug Fixes

* make Codex and OpenCode delegation reliable ([974e0d1](https://github.com/AksharP5/cohall/commit/974e0d127a56060ee9fec0210b138a0879dde9d8))

## [0.3.0](https://github.com/AksharP5/cohall/compare/v0.2.0...v0.3.0) (2026-08-06)


### Features

* add durable task tracing ([b7c2564](https://github.com/AksharP5/cohall/commit/b7c2564c770453a3c67821a9521aacac4f4a58e2))

## 0.2.0 (2026-08-05)

- Initial public release of the CLI, embedded agent skill, optional MCP server,
  self-hosted relay, and cross-device delegation runtime.
