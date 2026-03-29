import fs from "fs";
import {execSync} from "child_process";
import {exiftool} from "exiftool-vendored";
import {createCanvas} from "canvas";

import {FRACTO_TILES_PORT} from "../../../constants.js";
import FractoColors from "../../../sdk/FractoColors.js";

const get_canvas_buffer = async (resolution, scope, focal_point, aspect_ratio) => {
   const all_params = [
      `width_px=${resolution}`,
      `focal_point_x=${focal_point.x}`,
      `focal_point_y=${focal_point.y}`,
      `scope=${scope}`,
      `resolution_factor=${2.0}`,
      `aspect_ratio=${aspect_ratio}`,
   ].join('&')
   const url = `http://localhost:${FRACTO_TILES_PORT}/canvas_buffer?${all_params}`
   try {
      const result = await fetch(url, {}).then(res => res.json())
      return result.canvas_buffer
   } catch (e) {
      console.error(`error fetching ${url}`)
      return []
   }
}

export const handle_render_image = async (req, res) => {
   const width_px = parseInt(req.query.width_px)
   const aspect_ratio = parseFloat(req.query.aspect_ratio)
   const height_px = width_px * aspect_ratio
   const scope = parseFloat(req.query.scope)
   const focal_point = {
      x: parseFloat(req.query.focal_point_x),
      y: parseFloat(req.query.focal_point_y),
   }
   const random_name = `img_${Math.round(Math.random() * 100000000)}`
   const filename = `${random_name}.jpg`
   const filePath = `./images/${filename}`
   const time_1 = performance.now()
   try {
      const canvas_buffer = await get_canvas_buffer(
         width_px, scope, focal_point, aspect_ratio);
      const canvas = createCanvas(width_px, height_px);
      const ctx = canvas.getContext('2d');
      FractoColors.buffer_to_canvas(canvas_buffer, ctx)
      const buffer = canvas.toBuffer('image/jpeg');
      fs.writeFileSync(filePath, buffer); // Saves as output.png
      console.log('Image saved successfully!');
   } catch (e) {
      console.log('error writing file', e.message)
   }
   const time_2 = performance.now()
   const result = {
      asset_id: random_name,
      width_px,
      aspect_ratio,
      focal_point,
      scope,
      filename,
      public_url: `https://mikehallstudio.s3.us-east-1.amazonaws.com/fracto/images/${filename}`,
   }
   const time_3 = performance.now()
   try {
      await exiftool.write(filePath, {
         Title: 'Fracto Image Capture',
         Copyright: '(c) 2025 Fracto Chaotic Systems Group',
         Subject: 'fractals,math,art,mandelbrot',
         'XMP:Subject': 'fractals,math,art,mandelbrot',
         Software: JSON.stringify(result),
         'XMP:Description': JSON.stringify(result),
      });
      console.log('EXIF data added successfully!');
   } catch (err) {
      console.error('Error adding EXIF data:', err);
   }
   const time_4 = performance.now()

   try {
      const cmd = `aws s3 cp ${filePath} s3://mikehallstudio/fracto/images/ --acl public-read`
      console.log('uploading to s3', cmd)
      execSync(cmd)
      console.log('upload completed')
   } catch (e) {
      console.log('Error uploading to s3', e.message);
   }
   const time_5 = performance.now()

   result.performance = {
      buffer_to_canvas: `${time_2 - time_1}`,
      writeFileSync: `${time_3 - time_2}`,
      exiftool: `${time_4 - time_3}`,
      s3_upload: `${time_5 - time_4}`,
      total: `${time_5 - time_1}`,
   }
   console.log('result', result)
   res.status(200).send(result);
}