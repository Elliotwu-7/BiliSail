import 'dart:ffi';

import 'package:media_kit_video/media_kit_video.dart' as mkv;

import 'player_contract.dart';

/// Prefer Android's MediaCodec path, with mpv's safe decoder fallback. A usable
/// Surface must be attached in on_load before the decoder is created.
/// The actual decoder still depends on the device and source codec.
mkv.VideoControllerConfiguration videoDecoderConfiguration({
  required bool isAndroid,
  required VideoDecodingMode decoding,
  bool? isAndroidX64,
}) {
  final x64 = isAndroid && (isAndroidX64 ?? Abi.current() == Abi.androidX64);
  final useX64Fallback = x64 && decoding == VideoDecodingMode.automatic;

  return mkv.VideoControllerConfiguration(
    // Some Android x86_64 vehicle builds expose an incomplete EGL interface to
    // the legacy GPU output. gpu-next also supports Vulkan and avoids that path.
    vo: useX64Fallback ? 'gpu-next' : null,
    // Their vendor MediaCodec OMX implementation also crashes while releasing
    // buffers. Keep x86_64 on software decoding until the driver is validated.
    hwdec: decoding == VideoDecodingMode.software || useX64Fallback
        ? 'no'
        : isAndroid
        ? 'mediacodec,auto-safe'
        : null,
    androidAttachSurfaceAfterVideoParameters:
        isAndroid && decoding == VideoDecodingMode.automatic ? false : null,
  );
}
