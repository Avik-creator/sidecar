import { nativeImage, type NativeImage } from "electron";

const TRAY_2X =
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAqUlEQVR42mNgGAXUA/xAPBGIawbCcm0g/o+Em+jtgP9YMN3A8YF2wH9qOyALi2FiONTm0sIB/0kw9D+9HQDCgkSolabEATZEOCIDiPVp4XsYOEaEI3DhLbRO3YSwHDWz2H4KHIINzyPHEfJUdgQIl5PjkPVUdoTKkHHAgEbBgCbCAc2GA1oQDXhRPOCV0YBXxwPeIBnwJtmQa5QyDAYHDHjHZMC7ZkMXAABTpkqKPkdBDwAAAABJRU5ErkJggg==";

export function createTrayImage(): NativeImage {
  const image = nativeImage.createFromBuffer(Buffer.from(TRAY_2X, "base64"), {
    scaleFactor: 2,
  });
  image.setTemplateImage(true);
  return image;
}
