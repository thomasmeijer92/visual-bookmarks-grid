import { existsSync, readFileSync } from "node:fs";

const validateDataset = (dataPath) => {
  const data = JSON.parse(readFileSync(dataPath, "utf8"));
  const folders = data.folders;
  const bookmarks = data.bookmarks;
  const errors = [];

  if (!Array.isArray(folders)) errors.push("folders must be an array");
  if (!Array.isArray(bookmarks)) errors.push("bookmarks must be an array");

  const ids = new Set();
  let withImages = 0;
  let tagged = 0;

  if (Array.isArray(folders)) {
    const folderNames = new Set();
    for (const [index, folder] of folders.entries()) {
      if (!folder || typeof folder !== "object") {
        errors.push(`folder ${index} must be an object`);
        continue;
      }
      if (!folder.id) errors.push(`folder ${index} is missing id`);
      if (!folder.name) errors.push(`folder ${index} is missing name`);
      if (folder.name && folderNames.has(folder.name)) errors.push(`duplicate folder name ${folder.name}`);
      if (folder.name) folderNames.add(folder.name);
    }
  }

  if (Array.isArray(bookmarks)) {
    for (const [index, bookmark] of bookmarks.entries()) {
      if (!bookmark || typeof bookmark !== "object") {
        errors.push(`bookmark ${index} must be an object`);
        continue;
      }

      if (!bookmark.id) errors.push(`bookmark ${index} is missing id`);
      if (bookmark.id && ids.has(bookmark.id)) errors.push(`duplicate bookmark id ${bookmark.id}`);
      if (bookmark.id) ids.add(bookmark.id);

      if (!Array.isArray(bookmark.images)) {
        errors.push(`bookmark ${bookmark.id || index} images must be an array`);
      } else if (bookmark.images.length > 0) {
        withImages++;
        for (const [imageIndex, image] of bookmark.images.entries()) {
          if (!image || typeof image !== "object") {
            errors.push(`bookmark ${bookmark.id || index} image ${imageIndex} must be an object`);
            continue;
          }
          if (!image.url) errors.push(`bookmark ${bookmark.id || index} image ${imageIndex} is missing url`);
          if (!Number.isFinite(Number(image.width)) || Number(image.width) <= 0) {
            errors.push(`bookmark ${bookmark.id || index} image ${imageIndex} has invalid width`);
          }
          if (!Number.isFinite(Number(image.height)) || Number(image.height) <= 0) {
            errors.push(`bookmark ${bookmark.id || index} image ${imageIndex} has invalid height`);
          }
        }
      }

      if (!Array.isArray(bookmark.folders)) {
        errors.push(`bookmark ${bookmark.id || index} folders must be an array`);
      } else if (bookmark.folders.length > 0) {
        tagged++;
      }
    }
  }

  if (Array.isArray(bookmarks) && bookmarks.length > 0 && withImages === 0) {
    errors.push("at least one bookmark must include an image");
  }

  return {
    dataPath,
    errors,
    folderCount: Array.isArray(folders) ? folders.length : 0,
    bookmarkCount: Array.isArray(bookmarks) ? bookmarks.length : 0,
    tagged,
    withImages,
  };
};

const paths = ["bookmarks-data.sample.json"];
if (existsSync("bookmarks-data.json")) paths.push("bookmarks-data.json");

let failed = false;
for (const path of paths) {
  const result = validateDataset(path);
  if (result.errors.length > 0) {
    failed = true;
    console.error(`${path} failed with ${result.errors.length} error(s):`);
    for (const error of result.errors.slice(0, 20)) console.error(`- ${error}`);
    if (result.errors.length > 20) console.error(`- ${result.errors.length - 20} more errors`);
    continue;
  }

  console.log(
    `${path} check passed: ${result.bookmarkCount} bookmarks, ` +
      `${result.withImages} with images, ${result.tagged} tagged, ${result.folderCount} folders.`
  );
}

if (failed) process.exit(1);
