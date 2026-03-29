import fs from "fs";
import {execSync} from "child_process";
import path from "path";
import {exiftool} from "exiftool-vendored";
import {FRACTO_DATA_PORT} from "../../../constants.js";

import assets from './AssetImages.json' with {type: 'json'};

const SEPARATOR = path.sep;

console.log(`${assets.length} assets to process`)

let index = 0
for (const asset of assets) {
   index++
   const filename = `img_${asset}.jpg`
   const filepath = `..${SEPARATOR}images${SEPARATOR}${filename}`
   console.log(`asset ${asset} ${filepath} (#${index})`)
   if (fs.existsSync(filepath)) {
      console.log(`file ${filename} exists`)
      continue
   }
   // Download the file from s3
   try {
      const cmd = `aws s3 cp s3://mikehallstudio/fracto/images/${filename} ${filepath}`
      console.log('downloading from s3', cmd)
      execSync(cmd)
      console.log('download completed')
   } catch (e) {
      console.log('Error downloading from s3', e.message);
   }

   // read exif data
   let image_data = {};
   try {
      // Read all metadata tags from the specified image path
      const tags = await exiftool.read(filepath);
      image_data = JSON.parse(tags.Software);
      console.log('image_data:', image_data)
   } catch (err) {
      console.log('Error reading exif data', e.message);
   }

   // insert the data to the table
   const all_params = [
      `asset_id=${asset}`,
      `width=${image_data.width_px}`,
      `height=${image_data.height_px}`,
      `focal_point_x=${image_data.focal_point.x}`,
      `focal_point_y=${image_data.focal_point.y}`,
      `scope=${image_data.scope}`,
      `filename=${filename}`,
      `public_url=${image_data.public_url}`,
      `asset_type=image`,
   ].join('&')
   const url = `http://localhost:${FRACTO_DATA_PORT}/asset?${all_params}`
   try {
      const result = await fetch(url, {}).then(res => res.json())
      console.log('result',result)
   } catch (e) {
      console.error(`error fetching ${url}`)
   }
}