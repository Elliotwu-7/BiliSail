import 'package:bili_player/bili_player.dart';
import 'package:bili_player/src/video_decoder_configuration.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('Android automatic decoding attaches before decoder creation', () {
    final configuration = videoDecoderConfiguration(
      isAndroid: true,
      decoding: VideoDecodingMode.automatic,
      isAndroidX64: false,
    );
    expect(configuration.hwdec, 'mediacodec,auto-safe');
    expect(configuration.androidAttachSurfaceAfterVideoParameters, isFalse);
    expect(configuration.enableHardwareAcceleration, isTrue);
    expect(configuration.vo, isNull);
  });

  test('Android x86_64 automatic decoding avoids broken GPU and OMX paths', () {
    final configuration = videoDecoderConfiguration(
      isAndroid: true,
      decoding: VideoDecodingMode.automatic,
      isAndroidX64: true,
    );
    expect(configuration.hwdec, 'no');
    expect(configuration.androidAttachSurfaceAfterVideoParameters, isFalse);
    expect(configuration.enableHardwareAcceleration, isTrue);
    expect(configuration.vo, 'gpu-next');
  });

  test(
    'software decoding retains the GPU output and deferred Surface size',
    () {
      for (final isAndroid in [true, false]) {
        final configuration = videoDecoderConfiguration(
          isAndroid: isAndroid,
          decoding: VideoDecodingMode.software,
          isAndroidX64: true,
        );
        expect(configuration.hwdec, 'no');
        expect(configuration.vo, isNull);
        expect(configuration.enableHardwareAcceleration, isTrue);
        expect(configuration.androidAttachSurfaceAfterVideoParameters, isNull);
      }
    },
  );

  test('desktop automatic decoding retains SDK defaults', () {
    final configuration = videoDecoderConfiguration(
      isAndroid: false,
      decoding: VideoDecodingMode.automatic,
    );
    expect(configuration.hwdec, isNull);
    expect(configuration.vo, isNull);
    expect(configuration.androidAttachSurfaceAfterVideoParameters, isNull);
  });
}
