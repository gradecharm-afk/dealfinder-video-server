const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const app = express();
app.use(express.json({ limit: '50mb' }));

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'DealFinder Video Generator Running!' });
});

// Download file helper
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const protocol = url.startsWith('https') ? https : http;
    protocol.get(url, response => {
      response.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', err => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

// Run command helper
function runCommand(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: 120000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message));
      else resolve(stdout);
    });
  });
}

// Main video generation endpoint
app.post('/generate', async (req, res) => {
  const {
    imageUrl,
    audioUrl,
    audioBase64,
    title,
    price,
    originalPrice,
    discount,
    category
  } = req.body;

  const tmpDir = `/tmp/video_${Date.now()}`;
  fs.mkdirSync(tmpDir, { recursive: true });

  const imagePath = path.join(tmpDir, 'product.jpg');
  const audioPath = path.join(tmpDir, 'voice.mp3');
  const outputPath = path.join(tmpDir, 'output.mp4');

  try {
    // Step 1: Download product image
    console.log('Downloading image...');
    await downloadFile(imageUrl, imagePath);

    // Step 2: Save audio (base64 or URL)
    console.log('Saving audio...');
    if (audioBase64) {
      const audioBuffer = Buffer.from(audioBase64, 'base64');
      fs.writeFileSync(audioPath, audioBuffer);
    } else if (audioUrl) {
      await downloadFile(audioUrl, audioPath);
    }

    // Step 3: Get audio duration
    const durationCmd = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`;
    const durationStr = await runCommand(durationCmd);
    const duration = parseFloat(durationStr.trim()) || 15;
    console.log('Audio duration:', duration);

    // Step 4: Build FFmpeg filter for video
    const discountText = discount + '% OFF!';
    const priceText = 'NOW ONLY $' + price;
    const wasText = 'Was $' + originalPrice;
    const titleShort = title.substring(0, 40).replace(/['"\\:]/g, '');
    const ctaText = 'LINK IN BIO - LIMITED STOCK!';

    // Safe text for FFmpeg
    const safeTitle = titleShort.replace(/[^a-zA-Z0-9 !.,%-]/g, '');
    const safeDiscount = discountText.replace(/[^a-zA-Z0-9 !%]/g, '');
    const safePrice = priceText.replace(/[^a-zA-Z0-9 $!.]/g, '');
    const safeWas = wasText.replace(/[^a-zA-Z0-9 $!.]/g, '');

    // FFmpeg command - creates vertical 1080x1920 video
    const ffmpegCmd = `ffmpeg -y \
      -loop 1 -i "${imagePath}" \
      -i "${audioPath}" \
      -filter_complex " \
        [0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1[bg]; \
        [bg]zoompan=z='min(zoom+0.002,1.3)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${Math.ceil(duration * 30)}:s=1080x1920[zoomed]; \
        [zoomed]drawbox=x=0:y=0:w=1080:h=1920:color=black@0.45:t=fill[darkened]; \
        [darkened]drawtext=text='${safeDiscount}':fontsize=110:fontcolor=white:bordercolor=red:borderw=4:x=(w-text_w)/2:y=120:enable='between(t,0,${duration})', \
        drawtext=text='${safeTitle}':fontsize=42:fontcolor=white:bordercolor=black:borderw=3:x=(w-text_w)/2:y=320:enable='between(t,0,${duration})', \
        drawtext=text='${safeWas}':fontsize=50:fontcolor=gray:bordercolor=black:borderw=2:x=(w-text_w)/2:y=750:enable='between(t,${duration * 0.3},${duration})', \
        drawtext=text='${safePrice}':fontsize=80:fontcolor=yellow:bordercolor=black:borderw=3:x=(w-text_w)/2:y=850:enable='between(t,${duration * 0.3},${duration})', \
        drawtext=text='DealVault':fontsize=36:fontcolor=white:bordercolor=black:borderw=2:x=30:y=1850:enable='between(t,0,${duration})', \
        drawtext=text='${ctaText}':fontsize=44:fontcolor=white:bordercolor=red:borderw=3:x=(w-text_w)/2:y=1750:enable='between(t,${duration * 0.6},${duration})' \
      " \
      -map "[darkened]" -map 1:a \
      -c:v libx264 -preset fast -crf 23 \
      -c:a aac -b:a 128k \
      -t ${duration} \
      -pix_fmt yuv420p \
      "${outputPath}"`;

    console.log('Generating video...');
    await runCommand(ffmpegCmd);

    // Step 5: Read output and return as base64
    const videoBuffer = fs.readFileSync(outputPath);
    const videoBase64 = videoBuffer.toString('base64');

    console.log('Video generated! Size:', videoBuffer.length, 'bytes');

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });

    res.json({
      success: true,
      videoBase64: videoBase64,
      duration: duration,
      size: videoBuffer.length
    });

  } catch (error) {
    console.error('Error:', error.message);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    res.status(500).json({ success: false, error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Video Generator running on port ${PORT}`);
});
