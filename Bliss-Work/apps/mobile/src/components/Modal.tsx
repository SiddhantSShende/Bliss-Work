/**
 * The app's shared popup/sheet primitive. Implemented by GlassModal, which
 * renders into GlassProvider's overlay layer so the app behind it is genuinely
 * blurred on Android and iOS — an RN <Modal> is a separate window and cannot do
 * that on Android. Kept at this path so every existing `import { Modal }` works.
 */
export { GlassModal as Modal } from './glass/GlassModal';
export type { GlassModalProps as ModalProps } from './glass/GlassModal';
