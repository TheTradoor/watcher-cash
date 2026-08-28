# Watcher Pages Failure

Commit: 8ec13959f40c99cec5bdc78304013dc91aa0f04b
Run: 33209146889

```text
/tmp/pages-logs/build/5_Install locked web dependencies.txt:48:2026-08-28T20:39:32.0960443Z npm error Missing: @img/sharp-webcontainers-wasm32@0.35.4 from lock file
/tmp/pages-logs/build/5_Install locked web dependencies.txt:49:2026-08-28T20:39:32.0961960Z npm error Invalid: lock file's @img/sharp-win32-arm64@0.34.5 does not satisfy @img/sharp-win32-arm64@0.35.4
/tmp/pages-logs/build/5_Install locked web dependencies.txt:50:2026-08-28T20:39:32.0963692Z npm error Invalid: lock file's @img/sharp-win32-ia32@0.34.5 does not satisfy @img/sharp-win32-ia32@0.35.4
/tmp/pages-logs/build/5_Install locked web dependencies.txt:51:2026-08-28T20:39:32.0965323Z npm error Invalid: lock file's @img/sharp-win32-x64@0.34.5 does not satisfy @img/sharp-win32-x64@0.35.4
/tmp/pages-logs/build/5_Install locked web dependencies.txt:52:2026-08-28T20:39:32.0966932Z npm error Invalid: lock file's @img/sharp-wasm32@0.34.5 does not satisfy @img/sharp-wasm32@0.35.4
/tmp/pages-logs/build/5_Install locked web dependencies.txt:53:2026-08-28T20:39:32.0968172Z npm error
/tmp/pages-logs/build/5_Install locked web dependencies.txt:54:2026-08-28T20:39:32.0968827Z npm error Clean install a project
/tmp/pages-logs/build/5_Install locked web dependencies.txt:55:2026-08-28T20:39:32.0969477Z npm error
/tmp/pages-logs/build/5_Install locked web dependencies.txt:56:2026-08-28T20:39:32.0970015Z npm error Usage:
/tmp/pages-logs/build/5_Install locked web dependencies.txt:57:2026-08-28T20:39:32.0970585Z npm error npm ci
/tmp/pages-logs/build/5_Install locked web dependencies.txt:58:2026-08-28T20:39:32.0971128Z npm error
/tmp/pages-logs/build/5_Install locked web dependencies.txt:59:2026-08-28T20:39:32.0971684Z npm error Options:
/tmp/pages-logs/build/5_Install locked web dependencies.txt:60:2026-08-28T20:39:32.0972815Z npm error [--install-strategy <hoisted|nested|shallow|linked>] [--legacy-bundling]
/tmp/pages-logs/build/5_Install locked web dependencies.txt:61:2026-08-28T20:39:32.0974513Z npm error [--global-style] [--omit <dev|optional|peer> [--omit <dev|optional|peer> ...]]
/tmp/pages-logs/build/5_Install locked web dependencies.txt:62:2026-08-28T20:39:32.0975948Z npm error [--include <prod|dev|optional|peer> [--include <prod|dev|optional|peer> ...]]
/tmp/pages-logs/build/5_Install locked web dependencies.txt:63:2026-08-28T20:39:32.0977323Z npm error [--strict-peer-deps] [--foreground-scripts] [--ignore-scripts]
/tmp/pages-logs/build/5_Install locked web dependencies.txt:64:2026-08-28T20:39:32.0978894Z npm error [--allow-directory <all|none|root>] [--allow-file <all|none|root>]
/tmp/pages-logs/build/5_Install locked web dependencies.txt:65:2026-08-28T20:39:32.0980208Z npm error [--allow-git <all|none|root>] [--allow-remote <all|none|root>]
/tmp/pages-logs/build/5_Install locked web dependencies.txt:66:2026-08-28T20:39:32.0981502Z npm error [--allow-scripts <package-list> [--allow-scripts <package-list> ...]]
/tmp/pages-logs/build/5_Install locked web dependencies.txt:67:2026-08-28T20:39:32.0982985Z npm error [--strict-allow-scripts] [--dangerously-allow-all-scripts] [--no-audit]
/tmp/pages-logs/build/5_Install locked web dependencies.txt:68:2026-08-28T20:39:32.0984137Z npm error [--no-bin-links] [--no-fund] [--dry-run]
/tmp/pages-logs/build/5_Install locked web dependencies.txt:69:2026-08-28T20:39:32.0985310Z npm error [-w|--workspace <workspace-name> [-w|--workspace <workspace-name> ...]]
/tmp/pages-logs/build/5_Install locked web dependencies.txt:70:2026-08-28T20:39:32.0986591Z npm error [--workspaces] [--include-workspace-root] [--install-links]
/tmp/pages-logs/build/5_Install locked web dependencies.txt:71:2026-08-28T20:39:32.0987665Z npm error
/tmp/pages-logs/build/5_Install locked web dependencies.txt:72:2026-08-28T20:39:32.0988336Z npm error   --install-strategy
/tmp/pages-logs/build/5_Install locked web dependencies.txt:73:2026-08-28T20:39:32.0989344Z npm error     Sets the strategy for installing packages in node_modules.
/tmp/pages-logs/build/5_Install locked web dependencies.txt:74:2026-08-28T20:39:32.0990175Z npm error
/tmp/pages-logs/build/5_Install locked web dependencies.txt:75:2026-08-28T20:39:32.0990872Z npm error   --legacy-bundling
/tmp/pages-logs/build/5_Install locked web dependencies.txt:76:2026-08-28T20:39:32.0992034Z npm error     Instead of hoisting package installs in `node_modules`, install packages
/tmp/pages-logs/build/5_Install locked web dependencies.txt:77:2026-08-28T20:39:32.0993320Z npm error
/tmp/pages-logs/build/5_Install locked web dependencies.txt:78:2026-08-28T20:39:32.0993911Z npm error   --global-style
/tmp/pages-logs/build/5_Install locked web dependencies.txt:79:2026-08-28T20:39:32.0994939Z npm error     Only install direct dependencies in the top level `node_modules`,
/tmp/pages-logs/build/5_Install locked web dependencies.txt:80:2026-08-28T20:39:32.0995835Z npm error
/tmp/pages-logs/build/5_Install locked web dependencies.txt:81:2026-08-28T20:39:32.0996466Z npm error   --omit
/tmp/pages-logs/build/5_Install locked web dependencies.txt:82:2026-08-28T20:39:32.0997419Z npm error     Dependency types to omit from the installation tree on disk.
/tmp/pages-logs/build/5_Install locked web dependencies.txt:83:2026-08-28T20:39:32.0998508Z npm error
/tmp/pages-logs/build/5_Install locked web dependencies.txt:84:2026-08-28T20:39:32.0999078Z npm error   --include
/tmp/pages-logs/build/5_Install locked web dependencies.txt:85:2026-08-28T20:39:32.1000117Z npm error     Option that allows for defining which types of dependencies to install.
/tmp/pages-logs/build/5_Install locked web dependencies.txt:86:2026-08-28T20:39:32.1001051Z npm error
/tmp/pages-logs/build/5_Install locked web dependencies.txt:87:2026-08-28T20:39:32.1001669Z npm error   --strict-peer-deps
/tmp/pages-logs/build/5_Install locked web dependencies.txt:88:2026-08-28T20:39:32.1002696Z npm error     If set to `true`, and `--legacy-peer-deps` is not set, then _any_
/tmp/pages-logs/build/5_Install locked web dependencies.txt:89:2026-08-28T20:39:32.1003596Z npm error
/tmp/pages-logs/build/5_Install locked web dependencies.txt:90:2026-08-28T20:39:32.1004431Z npm error   --foreground-scripts
/tmp/pages-logs/build/5_Install locked web dependencies.txt:91:2026-08-28T20:39:32.1005453Z npm error     Run all build scripts (ie, `preinstall`, `install`, and
/tmp/pages-logs/build/5_Install locked web dependencies.txt:92:2026-08-28T20:39:32.1006296Z npm error
/tmp/pages-logs/build/5_Install locked web dependencies.txt:93:2026-08-28T20:39:32.1006947Z npm error   --ignore-scripts
/tmp/pages-logs/build/5_Install locked web dependencies.txt:94:2026-08-28T20:39:32.1008223Z npm error     If true, npm does not run scripts specified in package.json files.
/tmp/pages-logs/build/5_Install locked web dependencies.txt:95:2026-08-28T20:39:32.1009145Z npm error
/tmp/pages-logs/build/5_Install locked web dependencies.txt:96:2026-08-28T20:39:32.1009815Z npm error   --allow-directory
/tmp/pages-logs/build/5_Install locked web dependencies.txt:97:2026-08-28T20:39:32.1011048Z npm error     Limits the ability for npm to install dependencies from directories.
/tmp/pages-logs/build/5_Install locked web dependencies.txt:98:2026-08-28T20:39:32.1012065Z npm error
/tmp/pages-logs/build/5_Install locked web dependencies.txt:99:2026-08-28T20:39:32.1012733Z npm error   --allow-file
/tmp/pages-logs/build/5_Install locked web dependencies.txt:100:2026-08-28T20:39:32.1013893Z npm error     Limits the ability for npm to install dependencies from tarball files.
/tmp/pages-logs/build/5_Install locked web dependencies.txt:101:2026-08-28T20:39:32.1014691Z npm error
/tmp/pages-logs/build/5_Install locked web dependencies.txt:102:2026-08-28T20:39:32.1015067Z npm error   --allow-git
/tmp/pages-logs/build/5_Install locked web dependencies.txt:103:2026-08-28T20:39:32.1015687Z npm error     Limits the ability for npm to fetch dependencies from git references.
/tmp/pages-logs/build/5_Install locked web dependencies.txt:104:2026-08-28T20:39:32.1016221Z npm error
/tmp/pages-logs/build/5_Install locked web dependencies.txt:105:2026-08-28T20:39:32.1016587Z npm error   --allow-remote
/tmp/pages-logs/build/5_Install locked web dependencies.txt:106:2026-08-28T20:39:32.1017154Z npm error     Limits the ability for npm to fetch dependencies from urls.
/tmp/pages-logs/build/5_Install locked web dependencies.txt:107:2026-08-28T20:39:32.1018043Z npm error
/tmp/pages-logs/build/5_Install locked web dependencies.txt:108:2026-08-28T20:39:32.1018379Z npm error   --allow-scripts
/tmp/pages-logs/build/5_Install locked web dependencies.txt:109:2026-08-28T20:39:32.1018926Z npm error     Comma-separated list of packages whose install-time lifecycle scripts
/tmp/pages-logs/build/5_Install locked web dependencies.txt:110:2026-08-28T20:39:32.1019369Z npm error
/tmp/pages-logs/build/5_Install locked web dependencies.txt:111:2026-08-28T20:39:32.1019651Z npm error   --strict-allow-scripts
/tmp/pages-logs/build/5_Install locked web dependencies.txt:112:2026-08-28T20:39:32.1020158Z npm error     If `true`, turn the install-script policy from a warning into a hard
/tmp/pages-logs/build/5_Install locked web dependencies.txt:113:2026-08-28T20:39:32.1020556Z npm error
/tmp/pages-logs/build/5_Install locked web dependencies.txt:114:2026-08-28T20:39:32.1020851Z npm error   --dangerously-allow-all-scripts
/tmp/pages-logs/build/5_Install locked web dependencies.txt:115:2026-08-28T20:39:32.1021374Z npm error     If `true`, bypass the `allowScripts` policy entirely and run every
/tmp/pages-logs/build/5_Install locked web dependencies.txt:116:2026-08-28T20:39:32.1021953Z npm error
/tmp/pages-logs/build/5_Install locked web dependencies.txt:117:2026-08-28T20:39:32.1022166Z npm error   --audit
/tmp/pages-logs/build/5_Install locked web dependencies.txt:118:2026-08-28T20:39:32.1022663Z npm error     When "true" submit audit reports alongside the current npm command to the
/tmp/pages-logs/build/5_Install locked web dependencies.txt:119:2026-08-28T20:39:32.1023075Z npm error
/tmp/pages-logs/build/5_Install locked web dependencies.txt:120:2026-08-28T20:39:32.1023304Z npm error   --bin-links
/tmp/pages-logs/build/5_Install locked web dependencies.txt:121:2026-08-28T20:39:32.1023798Z npm error     Tells npm to create symlinks (or `.cmd` shims on Windows) for package
/tmp/pages-logs/build/5_Install locked web dependencies.txt:122:2026-08-28T20:39:32.1024205Z npm error
/tmp/pages-logs/build/5_Install locked web dependencies.txt:123:2026-08-28T20:39:32.1024413Z npm error   --fund
/tmp/pages-logs/build/5_Install locked web dependencies.txt:124:2026-08-28T20:39:32.1024890Z npm error     When "true" displays the message at the end of each `npm install`
/tmp/pages-logs/build/5_Install locked web dependencies.txt:125:2026-08-28T20:39:32.1025290Z npm error
/tmp/pages-logs/build/5_Install locked web dependencies.txt:126:2026-08-28T20:39:32.1025513Z npm error   --dry-run
/tmp/pages-logs/build/5_Install locked web dependencies.txt:127:2026-08-28T20:39:32.1026009Z npm error     Indicates that you don't want npm to make any changes and that it should
/tmp/pages-logs/build/5_Install locked web dependencies.txt:128:2026-08-28T20:39:32.1026426Z npm error
/tmp/pages-logs/build/5_Install locked web dependencies.txt:129:2026-08-28T20:39:32.1026653Z npm error   -w|--workspace
/tmp/pages-logs/build/5_Install locked web dependencies.txt:130:2026-08-28T20:39:32.1027164Z npm error     Enable running a command in the context of the configured workspaces of the
/tmp/pages-logs/build/5_Install locked web dependencies.txt:131:2026-08-28T20:39:32.1027911Z npm error
/tmp/pages-logs/build/5_Install locked web dependencies.txt:132:2026-08-28T20:39:32.1028352Z npm error   --workspaces
/tmp/pages-logs/build/5_Install locked web dependencies.txt:133:2026-08-28T20:39:32.1029271Z npm error     Set to true to run the command in the context of **all** configured
/tmp/pages-logs/build/5_Install locked web dependencies.txt:134:2026-08-28T20:39:32.1029831Z npm error
/tmp/pages-logs/build/5_Install locked web dependencies.txt:135:2026-08-28T20:39:32.1030120Z npm error   --include-workspace-root
/tmp/pages-logs/build/5_Install locked web dependencies.txt:136:2026-08-28T20:39:32.1030644Z npm error     Include the workspace root when workspaces are enabled for a command.
/tmp/pages-logs/build/5_Install locked web dependencies.txt:137:2026-08-28T20:39:32.1031264Z npm error
/tmp/pages-logs/build/5_Install locked web dependencies.txt:138:2026-08-28T20:39:32.1031495Z npm error   --install-links
/tmp/pages-logs/build/5_Install locked web dependencies.txt:139:2026-08-28T20:39:32.1031989Z npm error     When set file: protocol dependencies will be packed and installed as
/tmp/pages-logs/build/5_Install locked web dependencies.txt:140:2026-08-28T20:39:32.1032390Z npm error
/tmp/pages-logs/build/5_Install locked web dependencies.txt:141:2026-08-28T20:39:32.1032579Z npm error
/tmp/pages-logs/build/5_Install locked web dependencies.txt:142:2026-08-28T20:39:32.1032969Z npm error aliases: clean-install, ic, install-clean, isntall-clean
/tmp/pages-logs/build/5_Install locked web dependencies.txt:143:2026-08-28T20:39:32.1033330Z npm error
/tmp/pages-logs/build/5_Install locked web dependencies.txt:144:2026-08-28T20:39:32.1033601Z npm error Run "npm help ci" for more info
/tmp/pages-logs/build/5_Install locked web dependencies.txt:145:2026-08-28T20:39:32.1034276Z npm error A complete log of this run can be found in: /home/runner/.npm/_logs/2026-08-28T20_39_27_960Z-debug-0.log
/tmp/pages-logs/build/5_Install locked web dependencies.txt:146:2026-08-28T20:39:32.1525722Z ##[error]Process completed with exit code 1.
/tmp/pages-logs/build/3_Setup Node 24.txt:26:2026-08-28T20:39:21.2713027Z (node:2311) [DEP0169] DeprecationWarning: `url.parse()` behavior is not standardized and prone to errors that have security implications. Use the WHATWG URL API instead. CVEs are not issued for `url.parse()` vulnerabilities.
/tmp/pages-logs/build/4_Setup Go 1.25.txt:26:2026-08-28T20:39:25.6066187Z (node:2359) [DEP0169] DeprecationWarning: `url.parse()` behavior is not standardized and prone to errors that have security implications. Use the WHATWG URL API instead. CVEs are not issued for `url.parse()` vulnerabilities.
/tmp/pages-logs/1_build.txt:145:2026-08-28T20:39:21.2713126Z (node:2311) [DEP0169] DeprecationWarning: `url.parse()` behavior is not standardized and prone to errors that have security implications. Use the WHATWG URL API instead. CVEs are not issued for `url.parse()` vulnerabilities.
/tmp/pages-logs/1_build.txt:177:2026-08-28T20:39:25.6066217Z (node:2359) [DEP0169] DeprecationWarning: `url.parse()` behavior is not standardized and prone to errors that have security implications. Use the WHATWG URL API instead. CVEs are not issued for `url.parse()` vulnerabilities.
/tmp/pages-logs/1_build.txt:244:2026-08-28T20:39:32.0688882Z npm error code EUSAGE
/tmp/pages-logs/1_build.txt:245:2026-08-28T20:39:32.0855673Z npm error
/tmp/pages-logs/1_build.txt:246:2026-08-28T20:39:32.0856898Z npm error `npm ci` can only install packages when your package.json and package-lock.json or npm-shrinkwrap.json are in sync. Please update your lock file with `npm install` before continuing.
/tmp/pages-logs/1_build.txt:247:2026-08-28T20:39:32.0878167Z npm error
/tmp/pages-logs/1_build.txt:248:2026-08-28T20:39:32.0898836Z npm error Invalid: lock file's next@16.1.6 does not satisfy next@16.3.3
/tmp/pages-logs/1_build.txt:249:2026-08-28T20:39:32.0900267Z npm error Invalid: lock file's @next/env@16.1.6 does not satisfy @next/env@16.3.3
/tmp/pages-logs/1_build.txt:250:2026-08-28T20:39:32.0901952Z npm error Invalid: lock file's @next/swc-darwin-arm64@16.1.6 does not satisfy @next/swc-darwin-arm64@16.3.3
/tmp/pages-logs/1_build.txt:251:2026-08-28T20:39:32.0907180Z npm error Invalid: lock file's @next/swc-darwin-x64@16.1.6 does not satisfy @next/swc-darwin-x64@16.3.3
/tmp/pages-logs/1_build.txt:252:2026-08-28T20:39:32.0908726Z npm error Invalid: lock file's @next/swc-linux-arm64-gnu@16.1.6 does not satisfy @next/swc-linux-arm64-gnu@16.3.3
/tmp/pages-logs/1_build.txt:253:2026-08-28T20:39:32.0909666Z npm error Invalid: lock file's @next/swc-linux-arm64-musl@16.1.6 does not satisfy @next/swc-linux-arm64-musl@16.3.3
/tmp/pages-logs/1_build.txt:254:2026-08-28T20:39:32.0910557Z npm error Invalid: lock file's @next/swc-linux-x64-gnu@16.1.6 does not satisfy @next/swc-linux-x64-gnu@16.3.3
/tmp/pages-logs/1_build.txt:255:2026-08-28T20:39:32.0911767Z npm error Invalid: lock file's @next/swc-linux-x64-musl@16.1.6 does not satisfy @next/swc-linux-x64-musl@16.3.3
/tmp/pages-logs/1_build.txt:256:2026-08-28T20:39:32.0913429Z npm error Invalid: lock file's @next/swc-win32-arm64-msvc@16.1.6 does not satisfy @next/swc-win32-arm64-msvc@16.3.3
/tmp/pages-logs/1_build.txt:257:2026-08-28T20:39:32.0915032Z npm error Invalid: lock file's @next/swc-win32-x64-msvc@16.1.6 does not satisfy @next/swc-win32-x64-msvc@16.3.3
/tmp/pages-logs/1_build.txt:258:2026-08-28T20:39:32.0916408Z npm error Invalid: lock file's @swc/helpers@0.5.15 does not satisfy @swc/helpers@0.5.23
/tmp/pages-logs/1_build.txt:259:2026-08-28T20:39:32.0917775Z npm error Invalid: lock file's postcss@8.4.31 does not satisfy postcss@8.5.23
/tmp/pages-logs/1_build.txt:260:2026-08-28T20:39:32.0918891Z npm error Invalid: lock file's sharp@0.34.5 does not satisfy sharp@0.35.4
/tmp/pages-logs/1_build.txt:261:2026-08-28T20:39:32.0920493Z npm error Invalid: lock file's @img/sharp-darwin-arm64@0.34.5 does not satisfy @img/sharp-darwin-arm64@0.35.4
/tmp/pages-logs/1_build.txt:262:2026-08-28T20:39:32.0922014Z npm error Invalid: lock file's @img/sharp-darwin-x64@0.34.5 does not satisfy @img/sharp-darwin-x64@0.35.4
/tmp/pages-logs/1_build.txt:263:2026-08-28T20:39:32.0923423Z npm error Missing: @img/sharp-freebsd-wasm32@0.35.4 from lock file
/tmp/pages-logs/1_build.txt:264:2026-08-28T20:39:32.0925257Z npm error Invalid: lock file's @img/sharp-libvips-darwin-arm64@1.2.4 does not satisfy @img/sharp-libvips-darwin-arm64@1.3.3
/tmp/pages-logs/1_build.txt:265:2026-08-28T20:39:32.0927306Z npm error Invalid: lock file's @img/sharp-libvips-darwin-x64@1.2.4 does not satisfy @img/sharp-libvips-darwin-x64@1.3.3
/tmp/pages-logs/1_build.txt:266:2026-08-28T20:39:32.0929456Z npm error Invalid: lock file's @img/sharp-libvips-linux-arm@1.2.4 does not satisfy @img/sharp-libvips-linux-arm@1.3.3
/tmp/pages-logs/1_build.txt:267:2026-08-28T20:39:32.0931424Z npm error Invalid: lock file's @img/sharp-libvips-linux-arm64@1.2.4 does not satisfy @img/sharp-libvips-linux-arm64@1.3.3
/tmp/pages-logs/1_build.txt:268:2026-08-28T20:39:32.0933413Z npm error Invalid: lock file's @img/sharp-libvips-linux-ppc64@1.2.4 does not satisfy @img/sharp-libvips-linux-ppc64@1.3.3
/tmp/pages-logs/1_build.txt:269:2026-08-28T20:39:32.0935401Z npm error Invalid: lock file's @img/sharp-libvips-linux-riscv64@1.2.4 does not satisfy @img/sharp-libvips-linux-riscv64@1.3.3
/tmp/pages-logs/1_build.txt:270:2026-08-28T20:39:32.0937378Z npm error Invalid: lock file's @img/sharp-libvips-linux-s390x@1.2.4 does not satisfy @img/sharp-libvips-linux-s390x@1.3.3
/tmp/pages-logs/1_build.txt:271:2026-08-28T20:39:32.0939759Z npm error Invalid: lock file's @img/sharp-libvips-linux-x64@1.2.4 does not satisfy @img/sharp-libvips-linux-x64@1.3.3
/tmp/pages-logs/1_build.txt:272:2026-08-28T20:39:32.0941824Z npm error Invalid: lock file's @img/sharp-libvips-linuxmusl-arm64@1.2.4 does not satisfy @img/sharp-libvips-linuxmusl-arm64@1.3.3
/tmp/pages-logs/1_build.txt:273:2026-08-28T20:39:32.0943630Z npm error Invalid: lock file's @img/sharp-libvips-linuxmusl-x64@1.2.4 does not satisfy @img/sharp-libvips-linuxmusl-x64@1.3.3
/tmp/pages-logs/1_build.txt:274:2026-08-28T20:39:32.0945575Z npm error Invalid: lock file's @img/sharp-linux-arm@0.34.5 does not satisfy @img/sharp-linux-arm@0.35.4
/tmp/pages-logs/1_build.txt:275:2026-08-28T20:39:32.0947725Z npm error Invalid: lock file's @img/sharp-linux-arm64@0.34.5 does not satisfy @img/sharp-linux-arm64@0.35.4
/tmp/pages-logs/1_build.txt:276:2026-08-28T20:39:32.0949636Z npm error Invalid: lock file's @img/sharp-linux-ppc64@0.34.5 does not satisfy @img/sharp-linux-ppc64@0.35.4
/tmp/pages-logs/1_build.txt:277:2026-08-28T20:39:32.0951492Z npm error Invalid: lock file's @img/sharp-linux-riscv64@0.34.5 does not satisfy @img/sharp-linux-riscv64@0.35.4
/tmp/pages-logs/1_build.txt:278:2026-08-28T20:39:32.0953254Z npm error Invalid: lock file's @img/sharp-linux-s390x@0.34.5 does not satisfy @img/sharp-linux-s390x@0.35.4
/tmp/pages-logs/1_build.txt:279:2026-08-28T20:39:32.0955006Z npm error Invalid: lock file's @img/sharp-linux-x64@0.34.5 does not satisfy @img/sharp-linux-x64@0.35.4
/tmp/pages-logs/1_build.txt:280:2026-08-28T20:39:32.0956784Z npm error Invalid: lock file's @img/sharp-linuxmusl-arm64@0.34.5 does not satisfy @img/sharp-linuxmusl-arm64@0.35.4
/tmp/pages-logs/1_build.txt:281:2026-08-28T20:39:32.0958977Z npm error Invalid: lock file's @img/sharp-linuxmusl-x64@0.34.5 does not satisfy @img/sharp-linuxmusl-x64@0.35.4
/tmp/pages-logs/1_build.txt:282:2026-08-28T20:39:32.0960449Z npm error Missing: @img/sharp-webcontainers-wasm32@0.35.4 from lock file
/tmp/pages-logs/1_build.txt:283:2026-08-28T20:39:32.0961966Z npm error Invalid: lock file's @img/sharp-win32-arm64@0.34.5 does not satisfy @img/sharp-win32-arm64@0.35.4
/tmp/pages-logs/1_build.txt:284:2026-08-28T20:39:32.0963698Z npm error Invalid: lock file's @img/sharp-win32-ia32@0.34.5 does not satisfy @img/sharp-win32-ia32@0.35.4
/tmp/pages-logs/1_build.txt:285:2026-08-28T20:39:32.0965335Z npm error Invalid: lock file's @img/sharp-win32-x64@0.34.5 does not satisfy @img/sharp-win32-x64@0.35.4
/tmp/pages-logs/1_build.txt:286:2026-08-28T20:39:32.0966948Z npm error Invalid: lock file's @img/sharp-wasm32@0.34.5 does not satisfy @img/sharp-wasm32@0.35.4
/tmp/pages-logs/1_build.txt:287:2026-08-28T20:39:32.0968179Z npm error
/tmp/pages-logs/1_build.txt:288:2026-08-28T20:39:32.0968832Z npm error Clean install a project
/tmp/pages-logs/1_build.txt:289:2026-08-28T20:39:32.0969482Z npm error
/tmp/pages-logs/1_build.txt:290:2026-08-28T20:39:32.0970019Z npm error Usage:
/tmp/pages-logs/1_build.txt:291:2026-08-28T20:39:32.0970589Z npm error npm ci
/tmp/pages-logs/1_build.txt:292:2026-08-28T20:39:32.0971132Z npm error
/tmp/pages-logs/1_build.txt:293:2026-08-28T20:39:32.0971688Z npm error Options:
/tmp/pages-logs/1_build.txt:294:2026-08-28T20:39:32.0972820Z npm error [--install-strategy <hoisted|nested|shallow|linked>] [--legacy-bundling]
/tmp/pages-logs/1_build.txt:295:2026-08-28T20:39:32.0974520Z npm error [--global-style] [--omit <dev|optional|peer> [--omit <dev|optional|peer> ...]]
/tmp/pages-logs/1_build.txt:296:2026-08-28T20:39:32.0975953Z npm error [--include <prod|dev|optional|peer> [--include <prod|dev|optional|peer> ...]]
/tmp/pages-logs/1_build.txt:297:2026-08-28T20:39:32.0977329Z npm error [--strict-peer-deps] [--foreground-scripts] [--ignore-scripts]
/tmp/pages-logs/1_build.txt:298:2026-08-28T20:39:32.0978910Z npm error [--allow-directory <all|none|root>] [--allow-file <all|none|root>]
/tmp/pages-logs/1_build.txt:299:2026-08-28T20:39:32.0980213Z npm error [--allow-git <all|none|root>] [--allow-remote <all|none|root>]
/tmp/pages-logs/1_build.txt:300:2026-08-28T20:39:32.0981507Z npm error [--allow-scripts <package-list> [--allow-scripts <package-list> ...]]
/tmp/pages-logs/1_build.txt:301:2026-08-28T20:39:32.0982991Z npm error [--strict-allow-scripts] [--dangerously-allow-all-scripts] [--no-audit]
/tmp/pages-logs/1_build.txt:302:2026-08-28T20:39:32.0984142Z npm error [--no-bin-links] [--no-fund] [--dry-run]
/tmp/pages-logs/1_build.txt:303:2026-08-28T20:39:32.0985315Z npm error [-w|--workspace <workspace-name> [-w|--workspace <workspace-name> ...]]
/tmp/pages-logs/1_build.txt:304:2026-08-28T20:39:32.0986597Z npm error [--workspaces] [--include-workspace-root] [--install-links]
/tmp/pages-logs/1_build.txt:305:2026-08-28T20:39:32.0987671Z npm error
/tmp/pages-logs/1_build.txt:306:2026-08-28T20:39:32.0988341Z npm error   --install-strategy
/tmp/pages-logs/1_build.txt:307:2026-08-28T20:39:32.0989349Z npm error     Sets the strategy for installing packages in node_modules.
/tmp/pages-logs/1_build.txt:308:2026-08-28T20:39:32.0990179Z npm error
/tmp/pages-logs/1_build.txt:309:2026-08-28T20:39:32.0990876Z npm error   --legacy-bundling
/tmp/pages-logs/1_build.txt:310:2026-08-28T20:39:32.0992334Z npm error     Instead of hoisting package installs in `node_modules`, install packages
/tmp/pages-logs/1_build.txt:311:2026-08-28T20:39:32.0993325Z npm error
/tmp/pages-logs/1_build.txt:312:2026-08-28T20:39:32.0993916Z npm error   --global-style
/tmp/pages-logs/1_build.txt:313:2026-08-28T20:39:32.0994945Z npm error     Only install direct dependencies in the top level `node_modules`,
/tmp/pages-logs/1_build.txt:314:2026-08-28T20:39:32.0995840Z npm error
/tmp/pages-logs/1_build.txt:315:2026-08-28T20:39:32.0996471Z npm error   --omit
/tmp/pages-logs/1_build.txt:316:2026-08-28T20:39:32.0997424Z npm error     Dependency types to omit from the installation tree on disk.
/tmp/pages-logs/1_build.txt:317:2026-08-28T20:39:32.0998514Z npm error
/tmp/pages-logs/1_build.txt:318:2026-08-28T20:39:32.0999083Z npm error   --include
/tmp/pages-logs/1_build.txt:319:2026-08-28T20:39:32.1000122Z npm error     Option that allows for defining which types of dependencies to install.
/tmp/pages-logs/1_build.txt:320:2026-08-28T20:39:32.1001055Z npm error
/tmp/pages-logs/1_build.txt:321:2026-08-28T20:39:32.1001673Z npm error   --strict-peer-deps
/tmp/pages-logs/1_build.txt:322:2026-08-28T20:39:32.1002701Z npm error     If set to `true`, and `--legacy-peer-deps` is not set, then _any_
/tmp/pages-logs/1_build.txt:323:2026-08-28T20:39:32.1003601Z npm error
/tmp/pages-logs/1_build.txt:324:2026-08-28T20:39:32.1004438Z npm error   --foreground-scripts
/tmp/pages-logs/1_build.txt:325:2026-08-28T20:39:32.1005460Z npm error     Run all build scripts (ie, `preinstall`, `install`, and
/tmp/pages-logs/1_build.txt:326:2026-08-28T20:39:32.1006312Z npm error
/tmp/pages-logs/1_build.txt:327:2026-08-28T20:39:32.1006952Z npm error   --ignore-scripts
/tmp/pages-logs/1_build.txt:328:2026-08-28T20:39:32.1008231Z npm error     If true, npm does not run scripts specified in package.json files.
/tmp/pages-logs/1_build.txt:329:2026-08-28T20:39:32.1009151Z npm error
/tmp/pages-logs/1_build.txt:330:2026-08-28T20:39:32.1009823Z npm error   --allow-directory
/tmp/pages-logs/1_build.txt:331:2026-08-28T20:39:32.1011056Z npm error     Limits the ability for npm to install dependencies from directories.
/tmp/pages-logs/1_build.txt:332:2026-08-28T20:39:32.1012073Z npm error
/tmp/pages-logs/1_build.txt:333:2026-08-28T20:39:32.1012740Z npm error   --allow-file
/tmp/pages-logs/1_build.txt:334:2026-08-28T20:39:32.1013902Z npm error     Limits the ability for npm to install dependencies from tarball files.
/tmp/pages-logs/1_build.txt:335:2026-08-28T20:39:32.1014695Z npm error
/tmp/pages-logs/1_build.txt:336:2026-08-28T20:39:32.1015070Z npm error   --allow-git
/tmp/pages-logs/1_build.txt:337:2026-08-28T20:39:32.1015689Z npm error     Limits the ability for npm to fetch dependencies from git references.
/tmp/pages-logs/1_build.txt:338:2026-08-28T20:39:32.1016223Z npm error
/tmp/pages-logs/1_build.txt:339:2026-08-28T20:39:32.1016589Z npm error   --allow-remote
/tmp/pages-logs/1_build.txt:340:2026-08-28T20:39:32.1017157Z npm error     Limits the ability for npm to fetch dependencies from urls.
/tmp/pages-logs/1_build.txt:341:2026-08-28T20:39:32.1018057Z npm error
/tmp/pages-logs/1_build.txt:342:2026-08-28T20:39:32.1018382Z npm error   --allow-scripts
/tmp/pages-logs/1_build.txt:343:2026-08-28T20:39:32.1018929Z npm error     Comma-separated list of packages whose install-time lifecycle scripts
/tmp/pages-logs/1_build.txt:344:2026-08-28T20:39:32.1019371Z npm error
/tmp/pages-logs/1_build.txt:345:2026-08-28T20:39:32.1019654Z npm error   --strict-allow-scripts
/tmp/pages-logs/1_build.txt:346:2026-08-28T20:39:32.1020161Z npm error     If `true`, turn the install-script policy from a warning into a hard
/tmp/pages-logs/1_build.txt:347:2026-08-28T20:39:32.1020559Z npm error
/tmp/pages-logs/1_build.txt:348:2026-08-28T20:39:32.1020854Z npm error   --dangerously-allow-all-scripts
/tmp/pages-logs/1_build.txt:349:2026-08-28T20:39:32.1021377Z npm error     If `true`, bypass the `allowScripts` policy entirely and run every
/tmp/pages-logs/1_build.txt:350:2026-08-28T20:39:32.1021956Z npm error
/tmp/pages-logs/1_build.txt:351:2026-08-28T20:39:32.1022169Z npm error   --audit
/tmp/pages-logs/1_build.txt:352:2026-08-28T20:39:32.1022665Z npm error     When "true" submit audit reports alongside the current npm command to the
/tmp/pages-logs/1_build.txt:353:2026-08-28T20:39:32.1023077Z npm error
/tmp/pages-logs/1_build.txt:354:2026-08-28T20:39:32.1023310Z npm error   --bin-links
/tmp/pages-logs/1_build.txt:355:2026-08-28T20:39:32.1023805Z npm error     Tells npm to create symlinks (or `.cmd` shims on Windows) for package
/tmp/pages-logs/1_build.txt:356:2026-08-28T20:39:32.1024207Z npm error
/tmp/pages-logs/1_build.txt:357:2026-08-28T20:39:32.1024415Z npm error   --fund
/tmp/pages-logs/1_build.txt:358:2026-08-28T20:39:32.1024898Z npm error     When "true" displays the message at the end of each `npm install`
/tmp/pages-logs/1_build.txt:359:2026-08-28T20:39:32.1025292Z npm error
/tmp/pages-logs/1_build.txt:360:2026-08-28T20:39:32.1025515Z npm error   --dry-run
/tmp/pages-logs/1_build.txt:361:2026-08-28T20:39:32.1026011Z npm error     Indicates that you don't want npm to make any changes and that it should
/tmp/pages-logs/1_build.txt:362:2026-08-28T20:39:32.1026427Z npm error
/tmp/pages-logs/1_build.txt:363:2026-08-28T20:39:32.1026656Z npm error   -w|--workspace
/tmp/pages-logs/1_build.txt:364:2026-08-28T20:39:32.1027172Z npm error     Enable running a command in the context of the configured workspaces of the
/tmp/pages-logs/1_build.txt:365:2026-08-28T20:39:32.1027918Z npm error
/tmp/pages-logs/1_build.txt:366:2026-08-28T20:39:32.1028358Z npm error   --workspaces
/tmp/pages-logs/1_build.txt:367:2026-08-28T20:39:32.1029281Z npm error     Set to true to run the command in the context of **all** configured
/tmp/pages-logs/1_build.txt:368:2026-08-28T20:39:32.1029835Z npm error
/tmp/pages-logs/1_build.txt:369:2026-08-28T20:39:32.1030123Z npm error   --include-workspace-root
/tmp/pages-logs/1_build.txt:370:2026-08-28T20:39:32.1030844Z npm error     Include the workspace root when workspaces are enabled for a command.
/tmp/pages-logs/1_build.txt:371:2026-08-28T20:39:32.1031266Z npm error
/tmp/pages-logs/1_build.txt:372:2026-08-28T20:39:32.1031497Z npm error   --install-links
/tmp/pages-logs/1_build.txt:373:2026-08-28T20:39:32.1031991Z npm error     When set file: protocol dependencies will be packed and installed as
/tmp/pages-logs/1_build.txt:374:2026-08-28T20:39:32.1032392Z npm error
/tmp/pages-logs/1_build.txt:375:2026-08-28T20:39:32.1032581Z npm error
/tmp/pages-logs/1_build.txt:376:2026-08-28T20:39:32.1032971Z npm error aliases: clean-install, ic, install-clean, isntall-clean
/tmp/pages-logs/1_build.txt:377:2026-08-28T20:39:32.1033332Z npm error
/tmp/pages-logs/1_build.txt:378:2026-08-28T20:39:32.1033603Z npm error Run "npm help ci" for more info
/tmp/pages-logs/1_build.txt:379:2026-08-28T20:39:32.1034279Z npm error A complete log of this run can be found in: /home/runner/.npm/_logs/2026-08-28T20_39_27_960Z-debug-0.log
/tmp/pages-logs/1_build.txt:380:2026-08-28T20:39:32.1525749Z ##[error]Process completed with exit code 1.
```
