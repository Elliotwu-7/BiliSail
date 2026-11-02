import 'package:bilisail/app/theme.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('car UI scale enlarges shared text and operation icons by 20%', () {
    final theme = BiliTheme.light(uiScale: 1.2);

    expect(theme.iconTheme.size, closeTo(28.8, 0.001));
    expect(theme.textTheme.bodyMedium?.fontSize, closeTo(16.8, 0.001));
    expect(theme.textTheme.titleLarge?.fontSize, closeTo(24, 0.001));
    expect(
      theme.navigationRailTheme.selectedIconTheme?.size,
      closeTo(28.8, 0.001),
    );
  });

  test('invalid UI scale falls back to the normal theme size', () {
    final theme = BiliTheme.dark(uiScale: double.nan);

    expect(theme.iconTheme.size, 24);
    expect(theme.textTheme.bodyMedium?.fontSize, 14);
  });
}
