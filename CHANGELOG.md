# Changelog

## [0.10.1](https://github.com/AksharP5/cohall/compare/v0.10.0...v0.10.1) (2026-10-04)


### Bug Fixes

* **cli:** prevent oversized files from bypassing input limits ([#160](https://github.com/AksharP5/cohall/issues/160)) ([c6ef1d1](https://github.com/AksharP5/cohall/commit/c6ef1d1b31454b3baf755944cd0c6ef7021594c3))
* **config:** ignore invalid XDG directories ([#157](https://github.com/AksharP5/cohall/issues/157)) ([10e9acb](https://github.com/AksharP5/cohall/commit/10e9acbfdd2839e12b384467b568260c183a88ef))
* **providers:** preserve multipart OpenCode answers ([#161](https://github.com/AksharP5/cohall/issues/161)) ([219c988](https://github.com/AksharP5/cohall/commit/219c988ccfd5b3725242da5cbcab1ac27da63cf2))
* **relay:** keep usage available for all retained devices ([#159](https://github.com/AksharP5/cohall/issues/159)) ([a01b960](https://github.com/AksharP5/cohall/commit/a01b960437011148059871fb46d0fa14ab40361d))

## [0.10.0](https://github.com/AksharP5/cohall/compare/v0.9.0...v0.10.0) (2026-10-04)


### Features

* **tasks:** answer worker questions without restarting tasks ([#107](https://github.com/AksharP5/cohall/issues/107)) ([02c11a2](https://github.com/AksharP5/cohall/commit/02c11a27ca5b419eb721ed866331d350322406b8))
* **tasks:** recover submissions after a lost response ([#113](https://github.com/AksharP5/cohall/issues/113)) ([ced2061](https://github.com/AksharP5/cohall/commit/ced20612e70b44d653b6d0e3470722aa12524cc8))
* **tasks:** stop delegated coding work at a deadline ([#111](https://github.com/AksharP5/cohall/issues/111)) ([c221892](https://github.com/AksharP5/cohall/commit/c221892981c14478006fecd86c92e74750fe4f53))


### Bug Fixes

* **attachments:** bound local file reads after size checks ([#117](https://github.com/AksharP5/cohall/issues/117)) ([3c170e3](https://github.com/AksharP5/cohall/commit/3c170e3040add5216a835dbd9b7285993ee92f8a))
* **client:** read large task traces without relaxing other limits ([#138](https://github.com/AksharP5/cohall/issues/138)) ([48b7022](https://github.com/AksharP5/cohall/commit/48b70227717a118f8f091f84b8931e3179728ca5))
* **device:** clean task files before cancellation completes ([#127](https://github.com/AksharP5/cohall/issues/127)) ([9c7910e](https://github.com/AksharP5/cohall/commit/9c7910e862851b2500602a5f0f1b60fa33f0e6a7))
* **device:** reconnect when relay connections stall ([#129](https://github.com/AksharP5/cohall/issues/129)) ([c734f1d](https://github.com/AksharP5/cohall/commit/c734f1dcee1f1aa55b6a8883ba61a19aa2e48c21))
* **device:** reject queued work for disabled providers ([#152](https://github.com/AksharP5/cohall/issues/152)) ([baf441b](https://github.com/AksharP5/cohall/commit/baf441b9feae9398a34d72f0bb8d263ca9298ace))
* **device:** restore task status after reconnect ([#150](https://github.com/AksharP5/cohall/issues/150)) ([902c49a](https://github.com/AksharP5/cohall/commit/902c49ac626a6b5b606cfce4e0b6cc697c495266))
* **device:** retry relay switches without starting stopped workers ([#134](https://github.com/AksharP5/cohall/issues/134)) ([5a3817b](https://github.com/AksharP5/cohall/commit/5a3817b911f829a386fc11685f36f2abe3495c57))
* **device:** stop coding providers before worker exit ([#119](https://github.com/AksharP5/cohall/issues/119)) ([5835dc5](https://github.com/AksharP5/cohall/commit/5835dc5223333836f18ad4251f7d8d0035538934))
* **discovery:** read large device inventories through bounded pages ([#142](https://github.com/AksharP5/cohall/issues/142)) ([e02bf88](https://github.com/AksharP5/cohall/commit/e02bf884f3d7b139b70510feb5f323e5b76029ae))
* **doctor:** warn about unavailable gateways in automatic mode ([#146](https://github.com/AksharP5/cohall/issues/146)) ([44cbbdb](https://github.com/AksharP5/cohall/commit/44cbbdb1d4d7c4d1b4bff2d6f7015f2888c2c2eb))
* **mcp:** preserve results when requester waits are cancelled ([#123](https://github.com/AksharP5/cohall/issues/123)) ([ef7ca4a](https://github.com/AksharP5/cohall/commit/ef7ca4a13eddf1418c64e56df9a4eabd991cb998))
* **providers:** reject answers lost to event limits ([#122](https://github.com/AksharP5/cohall/issues/122)) ([5d2877b](https://github.com/AksharP5/cohall/commit/5d2877b07d3d4cc9db351a102c0a4e1145126efd))
* **relay:** preserve Bot questions completed while offline ([#151](https://github.com/AksharP5/cohall/issues/151)) ([024a319](https://github.com/AksharP5/cohall/commit/024a3199a171506963ac888d06bfccbb2ff5a0f7))
* **relay:** release Bot slots after rejected questions ([#154](https://github.com/AksharP5/cohall/issues/154)) ([6714f25](https://github.com/AksharP5/cohall/commit/6714f25536df87aeaccf8cfa887fccbffc72ac0a))
* **relay:** settle worker replies after history pruning ([#149](https://github.com/AksharP5/cohall/issues/149)) ([4bec2fd](https://github.com/AksharP5/cohall/commit/4bec2fd1e74873d0964bdf3bf15b8a9e9d03c1ea))
* **service:** honor the Linux user config directory ([#155](https://github.com/AksharP5/cohall/issues/155)) ([4d74a5e](https://github.com/AksharP5/cohall/commit/4d74a5edb591b7d197c2e26d70b83b06e82ff255))
* **service:** keep pnpm workers on the upgraded version ([#145](https://github.com/AksharP5/cohall/issues/145)) ([d72fc2c](https://github.com/AksharP5/cohall/commit/d72fc2cac0eadbb1991bdd848780f1a52b37b8a9))
* **setup:** preserve worker settings when repairing setup ([#153](https://github.com/AksharP5/cohall/issues/153)) ([9845f49](https://github.com/AksharP5/cohall/commit/9845f4982996c920e8f1aa3519264164d859f3bd))
* **tasks:** finish offline deadlines and confirm cancellation ([#118](https://github.com/AksharP5/cohall/issues/118)) ([639d185](https://github.com/AksharP5/cohall/commit/639d185b41572eb8c67f5f59c6d6fdbceb77a357))
* **tasks:** honor wait timeouts through relay responses ([#126](https://github.com/AksharP5/cohall/issues/126)) ([7918a3c](https://github.com/AksharP5/cohall/commit/7918a3c96a3c5079f5389b09d7adcc5202e7108b))
* **tasks:** preserve cancellation acknowledgements after reconnect ([#110](https://github.com/AksharP5/cohall/issues/110)) ([a5d503e](https://github.com/AksharP5/cohall/commit/a5d503e88a4a1585a595e2fea5ef1cf49e354c12))
* **upgrade:** keep unfinished restarts when changing versions ([#141](https://github.com/AksharP5/cohall/issues/141)) ([32bebb0](https://github.com/AksharP5/cohall/commit/32bebb079cebb66c6731000f9e2c0764cc04f798))
* **upgrade:** preserve newer installations when latest is older ([#103](https://github.com/AksharP5/cohall/issues/103)) ([1932a6a](https://github.com/AksharP5/cohall/commit/1932a6a359f5481a0ba11f9b6368b46c85c48553))
* **upgrade:** preserve unfinished restarts and validate recovery ([#137](https://github.com/AksharP5/cohall/issues/137)) ([c5c7930](https://github.com/AksharP5/cohall/commit/c5c7930ee1943bc1dc6bc847ed648b8368a3d2e8))
* **upgrade:** reject Windows tasks using a different installation ([#131](https://github.com/AksharP5/cohall/issues/131)) ([5c3987f](https://github.com/AksharP5/cohall/commit/5c3987f75ad3532788235c7195e120f65e75276f))
* **upgrade:** verify global installations before changing them ([#156](https://github.com/AksharP5/cohall/issues/156)) ([068e619](https://github.com/AksharP5/cohall/commit/068e619490173d1bbfcfbebcb218c8559ce61a2a))

## [0.9.0](https://github.com/AksharP5/cohall/compare/v0.8.0...v0.9.0) (2026-09-30)


### Features

* **devices:** show queue depth and oldest wait ([#95](https://github.com/AksharP5/cohall/issues/95)) ([f9a6f94](https://github.com/AksharP5/cohall/commit/f9a6f943b61a22840ce4be73f79a965fb5a193c3))
* **tasks:** report bounded worker progress ([#97](https://github.com/AksharP5/cohall/issues/97)) ([ced7062](https://github.com/AksharP5/cohall/commit/ced706251800fb4daa47f5ef9fe8e2672c9d445a))


### Bug Fixes

* **doctor:** report rejected client credentials ([#92](https://github.com/AksharP5/cohall/issues/92)) ([8744622](https://github.com/AksharP5/cohall/commit/87446220f84753d18b29d670dc5636c3036ac502))
* **mcp:** warn when upgrades need a connection restart ([#99](https://github.com/AksharP5/cohall/issues/99)) ([106e4a6](https://github.com/AksharP5/cohall/commit/106e4a645d0cf0814195ca8387cc45b2cb630c86))

## [0.8.0](https://github.com/AksharP5/cohall/compare/v0.7.0...v0.8.0) (2026-09-27)


### Features

* **doctor:** verify MCP server exposes tools ([#89](https://github.com/AksharP5/cohall/issues/89)) ([bee2abc](https://github.com/AksharP5/cohall/commit/bee2abcf64bd5715a88c560d07b8515455cd90d1))

## [0.7.0](https://github.com/AksharP5/cohall/compare/v0.6.2...v0.7.0) (2026-09-26)


### Features

* **delegation:** exchange bounded task files ([#86](https://github.com/AksharP5/cohall/issues/86)) ([8a2f808](https://github.com/AksharP5/cohall/commit/8a2f80841d52a189736a17b991277eaf0c267f23))
* **tasks:** surface completed work in a client inbox ([#84](https://github.com/AksharP5/cohall/issues/84)) ([a7a367f](https://github.com/AksharP5/cohall/commit/a7a367ff1ffcf9aa77d971d8f83d419154bbb656))

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
