# Android x86_64 适配记录

更新日期：2026-10-30。

本项目的构建流程新增 Android x86_64 独立 split APK，与 arm64-v8a 并列。Flutter 的目标名为 `android-x64`，项目内部 mux 目标名为 `android-x86_64`；两种 mux 均使用 API 24、NDK 28.2.13676358 和 16 KiB ELF 页对齐。两个架构共用包名、签名和 compact versionCode，不使用 Flutter 的 ABI versionCode 偏移。

已读取[固定 Predidit/media-kit 提交的 Native Assets 清单](https://github.com/Predidit/media-kit/blob/83b7ca63772856e1ea0158916177e136f7b7b0be/media_kit/hook/native_bundles.json)：`android_x64` 已提供 x86_64 Native Asset（`lib/x86_64/libmpv.so`），归档为 `v1.3.1/default-x86_64.jar`，SHA-256 为 `f01e9f1890091f4dd856cd37247e442d151b7815a86306581a1e9317ec566136`。没有更换依赖、二进制来源或绕过上游校验。

下载封装器新增同一 NDK 下的 `x86_64-linux-android24` 交叉编译。Gradle 仅把当前 Flutter `target-platform` 对应的 `libbili_mux.so` 放进 APK，Sync 清理另一架构的旧 staging 文件；独立的验证任务在 Sync 前检查库、许可与来源记录，避免所有文件缺失时被 `NO-SOURCE` 跳过。多架构 Flutter 构建须先准备两种 mux 组件。

本地构建入口：

```powershell
./tool/build-download-mux.ps1 -Target android-x86_64
./tool/build-android-development.ps1 -Target android-x86_64 -Mode Release
./tool/build-release.ps1 -Target android-x86_64 -Version 1.2.4+1
```

开发包输出到 `build/development/android-x86_64/BiliSail-test-x86_64-release.apk`，正式包输出到 `artifacts/android-x86_64/release/`。构建脚本会检查 APK 只有 `x86_64` ABI，并且包含 `libflutter.so`、`libmpv.so`、`libbili_mux.so` 及 Release AOT `libapp.so`。

CI 为 arm64 和 x86_64 各运行一个独立 Android 构建任务，使用同一签名配置与版本码。`enable_android` 同时控制两个目标；正式版本下载表只在实际存在对应附件时提供 x86_64 下载链接。开发包身份继续为 `dev.bilisail.bilisail.test`／「BiliSail 测试版」，默认仍构建 arm64；性能基准也可通过 `-Target android-x86_64` 选择架构，保持结束后覆盖恢复普通入口的流程。

## 本地验证

- `tool/test-android-targets.ps1` 的 24 项检查通过，覆盖两种目标映射、单 ABI、播放器与封装库缺失、混入其他 ABI、AOT 与 Debug kernel 边界。
- `tool/test_android_mux_build.py` 的 1 项测试（两种架构子场景）通过。通过模拟 configure/compiler/make 执行生产构建脚本，检查 NDK target、FFmpeg arch、API 24、16 KiB 对齐、独立输出及来源记录；不计为真实原生编译。
- `node --test tool/test-readme-downloads.cjs` 的 10 项测试通过，覆盖两种 Android 附件、部分发布和不存在附件时清理旧链接。
- 实际执行 CI 的矩阵生成片段，32 种平台开关组合通过；Android 开关正确包含或排除两个架构。
- actionlint 1.7.12 检查两份修改的工作流通过。
- 修改的 7 份 PowerShell 脚本解析、Bash 语法、修改文档的本地链接和 `git diff --check` 通过。
- 已执行 `tool/check.ps1 -SkipPub`，Android 版本 41 项、签名 21 项、开发包身份 7 项及新增 ABI 检查均通过，其他平台已有打包边界检查也通过；随后因缺少 `flutter` 命令而停止，不能计为全量通过。

当前主机没有 Flutter/Dart、Android SDK/NDK 或 JDK，未执行 Dart 分析／单测、真实 mux 编译或 APK 构建。未配置 `BILI_MUX_LIBRARY`，没有执行原生封装回归。x86_64 模拟器启动、DASH 双轨播放、PGC／直播、Surface 旋转／后台恢复、真实下载封装和覆盖升级仍待目标环境验收；远端 CI 尚未触发，历史 arm64 通过记录不能代替这些检查。
