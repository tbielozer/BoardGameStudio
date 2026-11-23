import { registerRootComponent } from 'expo';
import { LoadSkiaWeb } from '@shopify/react-native-skia/lib/module/web';

// On web, Skia draws through CanvasKit (WebAssembly). It must be loaded before
// any module that touches Skia is evaluated, so App is imported only afterwards.
// `npm install` copies canvaskit.wasm into public/ (see the postinstall script).
LoadSkiaWeb({ locateFile: (file: string) => `/${file}` })
  .then(async () => {
    const { default: App } = await import('./App');
    registerRootComponent(App);
  })
  .catch((error) => {
    console.error('Could not load Skia for web:', error);
  });
