import fs from "fs";
import {execSync} from "child_process";
import {exiftool} from "exiftool-vendored";
import {createCanvas} from "canvas";

import {
   fill_canvas_buffer,
   init_canvas_buffer
} from "../../../sdk/FractoTileData.js";
import FractoColors from "../../../sdk/FractoColors.js";

export const handle_render_image = async (req, res) => {
   const width_px = parseInt(req.query.width_px)
   const scope = parseFloat(req.query.scope)
   const focal_point = {
      x: parseFloat(req.query.focal_point_x),
      y: parseFloat(req.query.focal_point_y),
   }
   const aspect_ratio = parseFloat(req.query.aspect_ratio)
   const resolution_factor = parseFloat(req.query.resolution_factor)
   const canvas_buffer = init_canvas_buffer(width_px, aspect_ratio);

   const time_1 = performance.now()
   await fill_canvas_buffer(
      canvas_buffer,
      width_px,
      focal_point,
      scope,
      aspect_ratio,
      resolution_factor,
   )
   FractoTileCache.trim_cache()

   const canvas = createCanvas(width_px, height_px);
   const ctx = canvas.getContext('2d');
   FractoColors.buffer_to_canvas(canvas_buffer, ctx)
   const time_2 = performance.now()

   const random_name = `img_${Math.round(Math.random() * 100000000)}`
   const filename = `${random_name}.jpg`
   const filePath = `./images/${filename}`
   try {
      const buffer = canvas.toBuffer('image/jpeg');
      fs.writeFileSync(filePath, buffer); // Saves as output.png
      console.log('Image saved successfully!');
   } catch (e) {
      console.log('error writing file', e.message)
   }
   const time_3 = performance.now()

   const result = {
      asset_id: random_name,
      width_px,
      aspect_ratio,
      focal_point,
      scope,
      filename,
      public_url: `https://mikehallstudio.s3.us-east-1.amazonaws.com/fracto/images/${filename}`,
   }

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
      const cmd = `aws s3 cp ${filePath} s3://mikehallstudio/fracto/${collection}/ --acl public-read`
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