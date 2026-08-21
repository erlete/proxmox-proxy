# Changelog

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
