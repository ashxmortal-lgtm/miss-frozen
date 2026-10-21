import { createAccessService } from './access.js';
import { createSdkStore } from './store.js';

/** Production singleton used by handlers and endpoints. */
export const access = createAccessService(createSdkStore());
