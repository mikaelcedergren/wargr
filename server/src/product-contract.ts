import type { ProductManifest } from '@mikaelcedergren/cx-framework/server/product-manifest';

import { WARGR_PRODUCT_ID } from './constants.js';

export function assertWargrProductManifest(manifest: ProductManifest): void {
  const valid =
    manifest.id === WARGR_PRODUCT_ID &&
    manifest.family === 'web' &&
    manifest.profile === 'hybrid-site' &&
    manifest.deployment === 'mac-mini' &&
    manifest.frontend.framework === 'angular' &&
    manifest.frontend.rendering === 'ssg' &&
    manifest.frontend.designSystem === 'cx-framework' &&
    manifest.frontend.visualSystem === 'framework' &&
    manifest.capabilities.authentication === 'owner' &&
    manifest.capabilities.persistentData === 'structured-records' &&
    manifest.capabilities.backgroundWork === 'durable' &&
    manifest.capabilities.externalEffects.length === 1 &&
    manifest.capabilities.externalEffects[0] === 'ai';

  if (!valid) {
    throw new Error('Wargr runtime capabilities do not match cx-product.json.');
  }
}
