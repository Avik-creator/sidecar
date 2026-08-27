import { nativeImage, type NativeImage } from "electron";
import { trayMarkPng } from "./raster.js";

export function createTrayImage(): NativeImage {
  const image = nativeImage.createFromBuffer(trayMarkPng(32), {
    scaleFactor: 2,
  });
  image.setTemplateImage(true);
  return image;
}
