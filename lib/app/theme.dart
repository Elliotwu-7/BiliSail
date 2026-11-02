import 'package:flutter/material.dart';

import '../features/settings/domain/app_settings.dart';

abstract final class BiliTheme {
  static const accent = Color(0xFFD94B68);
  static const canvas = Colors.white;
  static const ink = Color(0xFF253343);

  static ThemeData light({
    AppFontPreference font = AppFontPreference.harmonyOsSans,
    String systemFontFamily = '',
    double uiScale = 1.0,
  }) => _build(
    Brightness.light,
    font.resolveFamily(systemFontFamily),
    uiScale: uiScale,
  );
  static ThemeData dark({
    AppFontPreference font = AppFontPreference.harmonyOsSans,
    String systemFontFamily = '',
    double uiScale = 1.0,
  }) => _build(
    Brightness.dark,
    font.resolveFamily(systemFontFamily),
    uiScale: uiScale,
  );

  static ThemeData _build(
    Brightness brightness,
    String? fontFamily, {
    double uiScale = 1.0,
  }) {
    final scale = uiScale.isFinite && uiScale > 0 ? uiScale : 1.0;
    final dark = brightness == Brightness.dark;
    final surface = dark ? const Color(0xFF1C2530) : canvas;
    final foreground = dark ? const Color(0xFFEAEAEA) : ink;
    final muted = dark ? const Color(0xFFACB8C7) : const Color(0xFF66778A);
    final panel = dark ? const Color(0xFF232F3D) : const Color(0xFFF2F6FA);
    final border = dark ? const Color(0xFF384657) : const Color(0xFFE1E9F1);
    final primary = dark ? const Color(0xFFEF8399) : accent;
    final scheme =
        ColorScheme.fromSeed(
          seedColor: accent,
          brightness: brightness,
        ).copyWith(
          primary: primary,
          onPrimary: dark ? const Color(0xFF35131C) : Colors.white,
          primaryContainer: dark
              ? const Color(0xFF442730)
              : const Color(0xFFFFEFF2),
          onPrimaryContainer: primary,
          secondary: primary,
          surface: surface,
          onSurface: foreground,
          onSurfaceVariant: muted,
          surfaceContainerLowest: surface,
          surfaceContainerLow: panel,
          surfaceContainer: panel,
          surfaceContainerHigh: dark
              ? const Color(0xFF2C3948)
              : const Color(0xFFEAF1F7),
          surfaceContainerHighest: dark
              ? const Color(0xFF334252)
              : const Color(0xFFE3EDF5),
          outline: muted,
          outlineVariant: border,
        );
    final base = ThemeData(
      useMaterial3: true,
      brightness: brightness,
      colorScheme: scheme,
      fontFamily: fontFamily,
      scaffoldBackgroundColor: dark
          ? const Color(0xFF141D27)
          : const Color(0xFFEDF3F9),
      dividerColor: border,
      hoverColor: primary.withValues(alpha: 0.045),
      focusColor: primary.withValues(alpha: 0.1),
      splashColor: primary.withValues(alpha: 0.08),
      iconTheme: IconThemeData(size: 24 * scale),
    );
    final controlShape = RoundedRectangleBorder(
      borderRadius: BorderRadius.circular(10),
    );
    final baseTextTheme = base.textTheme;
    TextStyle? scaledText(TextStyle? style) {
      final current = style;
      final fontSize = current?.fontSize;
      return current == null || fontSize == null
          ? current
          : current.copyWith(fontSize: fontSize * scale);
    }

    final scaledTextTheme = baseTextTheme.copyWith(
      displayLarge: scaledText(baseTextTheme.displayLarge),
      displayMedium: scaledText(baseTextTheme.displayMedium),
      displaySmall: scaledText(baseTextTheme.displaySmall),
      headlineLarge: scaledText(baseTextTheme.headlineLarge),
      headlineMedium: scaledText(baseTextTheme.headlineMedium),
      headlineSmall: scaledText(baseTextTheme.headlineSmall),
      titleLarge: scaledText(baseTextTheme.titleLarge),
      titleMedium: scaledText(baseTextTheme.titleMedium),
      titleSmall: scaledText(baseTextTheme.titleSmall),
      bodyLarge: scaledText(baseTextTheme.bodyLarge),
      bodyMedium: scaledText(baseTextTheme.bodyMedium),
      bodySmall: scaledText(baseTextTheme.bodySmall),
      labelLarge: scaledText(baseTextTheme.labelLarge),
      labelMedium: scaledText(baseTextTheme.labelMedium),
      labelSmall: scaledText(baseTextTheme.labelSmall),
    );

    return base.copyWith(
      appBarTheme: AppBarTheme(
        backgroundColor: surface,
        foregroundColor: foreground,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        scrolledUnderElevation: 0,
      ),
      navigationRailTheme: NavigationRailThemeData(
        backgroundColor: surface,
        indicatorColor: scheme.primaryContainer,
        selectedIconTheme: IconThemeData(color: primary, size: 24 * scale),
        unselectedIconTheme: IconThemeData(color: muted, size: 24 * scale),
        selectedLabelTextStyle: TextStyle(color: primary),
        unselectedLabelTextStyle: TextStyle(color: muted),
      ),
      navigationBarTheme: NavigationBarThemeData(
        backgroundColor: surface,
        surfaceTintColor: Colors.transparent,
        indicatorColor: scheme.primaryContainer,
        elevation: 0,
      ),
      cardTheme: CardThemeData(
        color: panel,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(8),
          side: BorderSide(color: border),
        ),
      ),
      dividerTheme: DividerThemeData(color: border, thickness: 1, space: 1),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: surface,
        isDense: true,
        contentPadding: const EdgeInsets.symmetric(
          horizontal: 12,
          vertical: 12,
        ),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(10),
          borderSide: BorderSide(color: border),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(10),
          borderSide: BorderSide(color: border),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(10),
          borderSide: BorderSide(color: primary),
        ),
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(shape: controlShape),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          shape: controlShape,
          side: BorderSide(color: border),
        ),
      ),
      textButtonTheme: TextButtonThemeData(
        style: TextButton.styleFrom(shape: controlShape),
      ),
      chipTheme: base.chipTheme.copyWith(
        shape: controlShape,
        side: BorderSide(color: border),
      ),
      textTheme: scaledTextTheme.copyWith(
        headlineMedium: baseTextTheme.headlineMedium?.copyWith(
          fontSize: 24 * scale,
          fontWeight: FontWeight.w500,
        ),
        titleLarge: baseTextTheme.titleLarge?.copyWith(
          fontSize: 20 * scale,
          fontWeight: FontWeight.w500,
        ),
        titleMedium: baseTextTheme.titleMedium?.copyWith(
          fontSize: 16 * scale,
          fontWeight: FontWeight.w500,
        ),
        titleSmall: baseTextTheme.titleSmall?.copyWith(
          fontSize: 14 * scale,
          fontWeight: FontWeight.w500,
        ),
        bodyMedium: baseTextTheme.bodyMedium?.copyWith(fontSize: 14 * scale),
        bodySmall: baseTextTheme.bodySmall?.copyWith(
          fontSize: 12 * scale,
          color: muted,
        ),
      ),
    );
  }
}
