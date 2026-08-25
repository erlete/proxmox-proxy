# Changelog

## [0.9.0](https://github.com/DLT-Code/proxmox-proxy/compare/v0.8.0...v0.9.0) (2026-08-25)


### Features

* **admin:** full backup and restore of the durable state ([5918347](https://github.com/DLT-Code/proxmox-proxy/commit/5918347b30337979b67fc9084f73f192635999c4))

## [0.8.0](https://github.com/DLT-Code/proxmox-proxy/compare/v0.7.3...v0.8.0) (2026-08-24)


### Features

* **admission:** stream guard serializes heavy ops on nodes with live consoles ([bb76349](https://github.com/DLT-Code/proxmox-proxy/commit/bb76349b27cc86d2b5d469461b6ce5c8b7761aff))

## [0.7.3](https://github.com/DLT-Code/proxmox-proxy/compare/v0.7.2...v0.7.3) (2026-08-24)


### Bug Fixes

* allow app vmid ranges to overlap; only reserved stays exclusive ([eee56f0](https://github.com/DLT-Code/proxmox-proxy/commit/eee56f0ae0316afc3aebdf5ecc3a2eac18bc76cc))
* **panel:** mark the Unassigned tree node with a warning dot ([4787734](https://github.com/DLT-Code/proxmox-proxy/commit/4787734c4dd5c04c191cec97ced78fecf7c2de8d))

## [0.7.2](https://github.com/DLT-Code/proxmox-proxy/compare/v0.7.1...v0.7.2) (2026-08-24)


### Bug Fixes

* **dataplane:** return the assigned clone VMID in an x-proxy-newid header ([90d502a](https://github.com/DLT-Code/proxmox-proxy/commit/90d502a42faa6335bceaf2866af91a9ce2bfa590))

## [0.7.1](https://github.com/DLT-Code/proxmox-proxy/compare/v0.7.0...v0.7.1) (2026-08-22)


### Bug Fixes

* **panel:** use the app mark as the browser favicon ([e07ffcd](https://github.com/DLT-Code/proxmox-proxy/commit/e07ffcd423dda57ba0a95740136f0b2cc4839ba9))

## [0.7.0](https://github.com/DLT-Code/proxmox-proxy/compare/v0.6.0...v0.7.0) (2026-08-22)


### Features

* **panel:** Proxmox VE console look and tree-driven navigation ([950a630](https://github.com/DLT-Code/proxmox-proxy/commit/950a630b7c966fcf2e87a55c79a8d3184bddd574))

## [0.6.0](https://github.com/DLT-Code/proxmox-proxy/compare/v0.5.2...v0.6.0) (2026-08-22)


### Features

* **proxy:** operate a linked-clone group as one unit ([4ecbfc9](https://github.com/DLT-Code/proxmox-proxy/commit/4ecbfc935c431755678f84774ded4c0ec340d731))

## [0.5.2](https://github.com/DLT-Code/proxmox-proxy/compare/v0.5.1...v0.5.2) (2026-08-22)


### Bug Fixes

* **proxy:** harden data plane and reaper per adversarial review ([34824ae](https://github.com/DLT-Code/proxmox-proxy/commit/34824aebe99885af10f11728d228671aff811bb3))

## [0.5.1](https://github.com/DLT-Code/proxmox-proxy/compare/v0.5.0...v0.5.1) (2026-08-22)


### Bug Fixes

* **reserved:** close LXC-clone and disk-move bypasses of reserved VMIDs ([14e01c3](https://github.com/DLT-Code/proxmox-proxy/commit/14e01c37150dcadb50b3f1ddfd64bc93747fbc5e))

## [0.5.0](https://github.com/DLT-Code/proxmox-proxy/compare/v0.4.0...v0.5.0) (2026-08-22)


### Features

* **admission:** reserved VMIDs and value-based app priority ([f565e36](https://github.com/DLT-Code/proxmox-proxy/commit/f565e36ef7140683dbd45bd1ea8086639f71eb8b))

## [0.4.0](https://github.com/DLT-Code/proxmox-proxy/compare/v0.3.0...v0.4.0) (2026-08-22)


### Features

* **keys:** purge revoked records; protect the show-once config modal ([483eff6](https://github.com/DLT-Code/proxmox-proxy/commit/483eff64c9df82a565bfa241c91c7b6f0354915d))

## [0.3.0](https://github.com/DLT-Code/proxmox-proxy/compare/v0.2.0...v0.3.0) (2026-08-22)


### Features

* **admission:** per-app fairness, manual priority tiers, settings reset ([ebbb4b0](https://github.com/DLT-Code/proxmox-proxy/commit/ebbb4b0b4a2141995f5dbed37412b4b9823f1100))
* **edge:** fold the edge into the app and deploy from a published image ([0732b5d](https://github.com/DLT-Code/proxmox-proxy/commit/0732b5de776dceafdff5b1f788e3d73bad79a0f4))
* **panel:** priority sequence editor and settings reset button ([5486bd3](https://github.com/DLT-Code/proxmox-proxy/commit/5486bd395be2721c2e88b9e122434a7e889a7e6d))

## [0.2.0](https://github.com/DLT-Code/proxmox-proxy/compare/v0.1.0...v0.2.0) (2026-08-21)


### Features

* **admission:** backstop out-of-band cluster load against the caps ([8aefb50](https://github.com/DLT-Code/proxmox-proxy/commit/8aefb5045f9334dbb41195f214d15cffefcc91eb))
* **admission:** fail closed on internal failure and lock loss ([7ef410f](https://github.com/DLT-Code/proxmox-proxy/commit/7ef410f0ce9a62d56dff071477bea5f488bc076a))
* **config:** zero-config bootstrap for panel password and session secret ([1629779](https://github.com/DLT-Code/proxmox-proxy/commit/1629779fa35c90c05a91b2b61de4b9d1eb833e7b))
* **console:** mint VNC console credentials for apps ([7ac9fe3](https://github.com/DLT-Code/proxmox-proxy/commit/7ac9fe32f84cefff5efdb1f6a88f1d6509f18b6b))
* **core:** admission-gated Proxmox passthrough with keys and singleton lock ([a95b5fc](https://github.com/DLT-Code/proxmox-proxy/commit/a95b5fc889ebd6d639f1c9997cc1d6fc8ce90a2d))
* **deploy:** docker compose with caddy as the only exposed entrypoint ([28b8c05](https://github.com/DLT-Code/proxmox-proxy/commit/28b8c05d0519e7b0602af77845a97852099fa534))
* **deploy:** single-port edge behind DEPLOY_HOST and DEPLOY_PORT ([11fe443](https://github.com/DLT-Code/proxmox-proxy/commit/11fe443c905748c54f67d8664ff6d2d9d3ba0b32))
* **panel:** operational red button and per-app inventory ([3eec19b](https://github.com/DLT-Code/proxmox-proxy/commit/3eec19b87710d1388d9ea9738f6ef275e571af19))
* **panel:** react management panel typed from the admin OpenAPI ([0ae5859](https://github.com/DLT-Code/proxmox-proxy/commit/0ae58599d7e0817426ffc0efc6b670cbf062bb8b))
* **panel:** visual redesign with waypoints branding and app-centric management ([525f72d](https://github.com/DLT-Code/proxmox-proxy/commit/525f72db589501f5d476ecdf1a884357260c3e34))
* **scripts:** live verification harness against a real cluster ([76bcdd7](https://github.com/DLT-Code/proxmox-proxy/commit/76bcdd72cff841081310bb1ace7da769c062f6cb))
* **settings:** panel-managed runtime settings applied hot ([39e7728](https://github.com/DLT-Code/proxmox-proxy/commit/39e772850e9a509d7b8b1d623801d57be98c88c1))


### Bug Fixes

* **admission:** don't count our own in-flight grants as out-of-band ([67290c2](https://github.com/DLT-Code/proxmox-proxy/commit/67290c2dec62335705131f00c101095b8549215a))
* **deploy:** default DATA_DIR to the /data volume in the image ([dc99f91](https://github.com/DLT-Code/proxmox-proxy/commit/dc99f91c23a7ae56261622320aa650a5d64261d5))
* **shutdown:** release the cluster lock before draining connections ([785c765](https://github.com/DLT-Code/proxmox-proxy/commit/785c7657ff293eb7d1b5fd26406dbf2b59e37b27))
