# Android 车机媒体会话适配记录

更新日期：2026-11-02。

BiliSail 已接入 Android 标准 `MediaSession`，用于把当前 Bilibili 播放会话提供给车机媒体消费者，并接收媒体按键和显式车机控制命令。适配桥位于 `android/app/src/main/kotlin/dev/bilisail/bilisail/CarMediaBridge.kt`、`CarMediaButtonReceiver.kt` 和 `lib/features/playback/application/car_media_coordinator.dart`。

## 数据与控制路径

```text
PlaybackSession.snapshots / 视频元数据
        ↓
CarMediaCoordinator
        ↓ MethodChannel
Android MediaSession
        ↓
车机媒体消费者 / MediaControl
```

播放标题、作者、分 P、封面地址、时长、播放状态、位置、倍速和能力位会同步到 `MediaMetadata` 与 `PlaybackState`。系统媒体会话的播放、暂停、播放／暂停、上一首、下一首、快进、快退和 seek 回调重新进入当前 `PlaybackSession`；上一首和下一首由当前播放页的导航命令执行，避免绕过工作区和播放代际校验。

进程被系统重建时，`CarMediaButtonReceiver` 只保存有限数量的抬起事件，应用初始化后再交给 Flutter 消费。Android 12 及以上媒体按键 `PendingIntent` 使用可变标志，以保留系统附加的 `KEY_EVENT`；接收器只处理 `ACTION_UP`，避免一次按键执行两次。

保留了一个显式扩展广播：

```text
action: dev.bilisail.bilisail.car.CONTROL
extra cmd: play / pause / toggle / next / prev / seekForward / seekBack
```

该广播用于车机适配联调，最终仍由 `PlaybackSession` 执行。播放页没有活动会话时，命令只进入有界队列，下一次初始化时消费。

## 31081 设备验证

设备：`frp.lynkco.love:31081`，型号 `E371`，Android 13 / API 33，实际 ABI 为 `x86_64`。安装的本地 Release 测试包为 `dev.bilisail.bilisail.test`，版本 `1.2.4` / `versionCode 12401`。安装使用 `adb install -r`，未卸载应用、清除数据或修改 `system`、`vendor` 分区。

已确认：

- 应用可启动，`BiliSail` MediaSession 为 `active=true`，flags 为 `3`，带有媒体按键 PendingIntent；
- Manifest 注册了 `android.intent.action.MEDIA_BUTTON` 和 `dev.bilisail.bilisail.car.CONTROL`；
- 车机系统能够列出 `dev.bilisail.bilisail.test/BiliSail` 会话；
- 自定义车机广播可以唤起应用进程，未观察到 BiliSail 崩溃；
- 设备同时存在车机 `ecarx.xsf.mediacenter` 和网易云 `com.netease.cloudmusic.iot` 会话，说明系统媒体会话列表和车机消费者可用。

本次设备停留在 BiliSail 首页，尚未完成登录后打开真实 Bilibili 视频的播放烟测，因此当前 `dumpsys media_session` 中 BiliSail 的 metadata/state 仍为空。需要在有可播放视频的会话中再次确认标题、作者、封面、时长、播放状态和进度是否进入车机小窗，并验证播放／暂停／切歌和进程重建后的媒体键闭环。

2026-11-02 重新构建了包含动态礼让逻辑的 x86_64 Release APK：`build/development/android-x86_64/BiliSail-test-x86_64-release.apk`，SHA-256 为 `6f48761bc4fa11369b7c550c509ff93f74a7e009dee9224b1fd80dea8642f78a`，包名 `dev.bilisail.bilisail.test`，版本 `1.2.4` / `versionCode 12401`。构建、APK 校验和脚本语法检查已通过。31081 上的小脚本已经覆盖并重新注入；75MB APK 的 ADB 大文件传输在 FRP 通道约 64KB 写入处出现协议错误，因此 APK 覆盖安装仍待稳定传输通道，未执行卸载或清数据。

## 与网易云私有适配的边界

当前实现是 Android 标准媒体会话适配，不包含网易云 2.0.617 所使用的 EAS 权限绕过、XSF Binder 注册、MediaControl 私有媒体源登记、媒体源认领或控制源选择。仓库没有这些专有 SDK、Binder 接口或可复现的正式 APK 基线，不能据此声称已经完成同等私有协议适配。

如果标准 `MediaSession` 在实车小窗中不能显示 BiliSail，需要提供目标车机的 EAS／XSF 接口定义、专有 SDK 或可分析的正式 APK，再单独实现私有媒体中心注册；继续刷新 Android `MediaSession` 数据不能替代这条链路。


## XSF / MediaControl 私有适配

标准 `MediaSession` 不能改变 XSF 当前选中的媒体源。本次适配增加了一个可选的运行时桥：`CarMediaCoordinator` 在 Android 播放会话变化时，通过 `CarMediaBridge.setXsfPayload` 将状态原子写入应用自己的缓存文件 `cache/car_media/xsf_payload.json`。在有 root Frida worker 的车机上，原生桥同时把同一份 JSON 镜像到 `/data/local/tmp/wyyyy_frida/bilisail_payload.json`，解决 XSF/MediaControl 与应用 UID 不同而无法遍历应用私有目录的问题。原生桥会覆盖写入实际安装包名，因此开发测试包和正式包共用同一套 Dart 逻辑。

APK 内的 `assets/car_media/inject_xsf_session_bilisail.js` 运行在 `ecarx.xsf.mediacenter`，使用车机已有的 `EasMediaSession` 注册 BiliSail 会话、发布 `PlaybackInfo`/`PlaybackState`、请求媒体中心焦点，并把 XSF 控制命令转成 `dev.bilisail.bilisail.car.CONTROL`。`inject_mediacontrol_bilisail.js` 运行在 `com.flyme.auto.mediacontrol`，维护 BiliSail 音源列表和当前 `MediaInfoDataSource`，让小窗读取到同一个会话。

脚本属于车机运行时适配，不修改系统分区或系统 APK。目标进程由已有 root Frida worker 注入；手动联调可在仓库根目录执行：

```sh
./tool/car_media/deploy-frida-bridge.sh frp.lynkco.love:31081
```

脚本会把两个适配器放入 `/data/local/tmp/wyyyy_frida/` 并注入当前已运行的 XSF/MediaControl 进程。目标进程重启后需要重新注入；正式集成应把这两个目标加入现有 worker 的进程重启恢复表，同时保留 EAS 注入在 `com.ecarx.sdk.openapi` 的顺序。

方向盘路径是 `XSF selected source → XSF controller → BiliSail CarMediaButtonReceiver → PlaybackSession`。音源仲裁按当前实际播放者进行：XSF 先检查活动的 MediaSession、AudioPlaybackConfiguration 和车机音频 owner；网易云、蓝牙、USB 或其他已知音源处于播放状态时，BiliSail 写入 `mediacontrol_foreign_owner.txt`、发送一次 `yield`，停止更新 XSF/小窗并抑制 BiliSail 控制转发。外部 owner 消失后，只有新鲜的 BiliSail payload 且 BiliSail 进程仍存活时才重新请求焦点、更新 selected owner 和小窗。MediaControl 侧对 `updatedAtMs` 强制执行 30 秒新鲜度检查；缺少时间戳或已过期的 `playing=true` 缓存不会重新抢占小窗。这个规则对应网易云脚本的礼让语义，避免旧缓存把方向盘和小窗错误地切回 BiliSail。

31081 的运行时联调已验证礼让分支：设备同时有网易云会话时，`inject_xsf_session_bilisail.log` 出现 `foreign owner marker owner=com.netease.cloudmusic.iot`、`control=yield` 和 `neutralize apple token ... foreignOwner=com.netease.cloudmusic.iot`；BiliSail heartbeat 为 `reason=yield-foreign-audio-timer`，而不是 BiliSail push。停止外部 owner 并让 BiliSail payload/进程恢复后，日志出现 `register ok pkg=dev.bilisail.bilisail.test`、`token ready`，heartbeat 恢复为 `reason=timer ... playing=true`，selected owner 文件为 `dev.bilisail.bilisail.test`。这验证了脚本层的双向礼让；实体方向盘按键和真实视频音频仍需在车上执行最终验收。

2026-11-02 在 31081 复现并修复了一条“占死 XSF”的路径：MediaControl watchdog 在 `latestMediaInfoBean` 为空时无条件重绑缓存的 `lastPlaybackInfo`，启动时的 `boot-last` 也会复活旧对象；而 BiliSail payload 已经是过期的 `playing=true`。修复后，`watchdog`、`boot` 和 `field g` 恢复路径统一要求 payload 的 `updatedAtMs` 在 30 秒内且仍为 playing；当前 owner 已过期时会丢弃缓存恢复对象。重新注入 31081 后，XSF 日志出现 `force payload paused reason=app-not-running`、`neutralize framework media session`、`neutralize cold-paused token`，MediaControl 没有 selected owner，`dumpsys media_session` 中也没有 BiliSail 会话。

当前脚本基于车上已验证的 Flyme-NET E371 类名和 `EasMediaSession` 接口，仍需在每次车机系统升级后重新核对混淆类。它不代表普通 APK 获得了 `signature|privileged` 的 EAS 权限；权限绕过和进程注入仍由车机已有的 root worker 完成。
