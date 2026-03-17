const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const app = express();
app.use(express.json({ limit: '100mb' }));

app.get('/', (req, res) => {
  res.json({ status: 'DealFinder Video Generator Running!' });
});

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    if (!url || typeof url !== 'string') {
      return reject(new Error('Invalid URL: ' + url));
    }
    const file = fs.createWriteStream(dest);
    const protocol = url.startsWith('https') ? https : http;
    protocol.get(url, response => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        file.close();
        return downloadFile(response.headers.location, dest).then(resolve).catch(reject);
      }
      response.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', err => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

function runCommand(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: 120000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message));
      else resolve(stdout);
    });
  });
}

function saveAudio(audioBase64, audioPath) {
  try {
    let clean = audioBase64 || '';
    // Remove data URI prefix if present
    if (clean.includes('base64,')) {
      clean = clean.split('base64,')[1];
    }
    // Remove all whitespace
    clean = clean.replace(/\s+/g, '');
    const buffer = Buffer.from(clean, 'base64');
    fs.writeFileSync(audioPath, buffer);
    return true;
  } catch (e) {
    console.error('Audio save error:', e.message);
    return false;
  }
}

app.post('/generate', async (req, res) => {
  const { imageUrl, audioBase64, title, price, originalPrice, discount } = req.body;

  const tmpDir = `/tmp/video_${Date.now()}`;
  fs.mkdirSync(tmpDir, { recursive: true });

  const imagePath = path.join(tmpDir, 'product.jpg');
  const audioPath = path.join(tmpDir, 'voice.mp3');
  const outputPath = path.join(tmpDir, 'output.mp4');

  try {
    console.log('Downloading image:', imageUrl);
    await downloadFile(imageUrl, imagePath);

    console.log('Saving audio...');
    saveAudio(audioBase64, audioPath);

    // Check if audio file is valid
    let duration = 15;
    try {
      const durationCmd = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`;
      const durationStr = await runCommand(durationCmd);
      duration = parseFloat(durationStr.trim()) || 15;
    } catch (e) {
      console.log('Could not get duration, using 15s');
    }

    const safeTitle = (title || 'Amazing Deal').substring(0, 40).replace(/['"\\:!]/g, '');
    const safePrice = String(price || '0').replace(/[^0-9.]/g, '');
    const safeOriginal = String(originalPrice || '0').replace(/[^0-9.]/g, '');
    const safeDiscount = String(discount || '0').replace(/[^0-9]/g, '');

    // Check if audio file exists and has content
    const audioExists = fs.existsSync(audioPath) && fs.statSync(audioPath).size > 100;
    
    let ffmpegCmd;
    if (audioExists) {
      ffmpegCmd = `ffmpeg -y \
        -loop 1 -i "${imagePath}" \
        -i "${audioPath}" \
        -filter_complex "\
          [0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1[bg];\
          [bg]drawbox=x=0:y=0:w=1080:h=1920:color=black@0.4:t=fill[darkened];\
          [darkened]drawtext=text='${safeDiscount}% OFF':fontsize=100:fontcolor=white:bordercolor=red:borderw=4:x=(w-text_w)/2:y=100,\
          drawtext=text='${safeTitle}':fontsize=38:fontcolor=white:bordercolor=black:borderw=3:x=(w-text_w)/2:y=300,\
          drawtext=text='Was $${safeOriginal}':fontsize=50:fontcolor=gray:bordercolor=black:borderw=2:x=(w-text_w)/2:y=750,\
          drawtext=text='Now $${safePrice}':fontsize=80:fontcolor=yellow:bordercolor=black:borderw=3:x=(w-text_w)/2:y=850,\
          drawtext=text='@fndit_cheap':fontsize=36:fontcolor=white:bordercolor=black:borderw=2:x=30:y=1850,\
          drawtext=text='LINK IN BIO':fontsize=50:fontcolor=white:bordercolor=red:borderw=3:x=(w-text_w)/2:y=1750\
        " \
        -map "[darkened]" -map 1:a \
        -c:v libx264 -preset fast -crf 23 \
        -c:a aac -b:a 128k \
        -t ${duration} \
        -pix_fmt yuv420p \
        "${outputPath}"`;
    } else {
      console.log('No valid audio, generating silent video...');
      ffmpegCmd = `ffmpeg -y \
        -loop 1 -i "${imagePath}" \
        -filter_complex "\
          [0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1[bg];\
          [bg]drawbox=x=0:y=0:w=1080:h=1920:color=black@0.4:t=fill[darkened];\
          [darkened]drawtext=text='${safeDiscount}% OFF':fontsize=100:fontcolor=white:bordercolor=red:borderw=4:x=(w-text_w)/2:y=100,\
          drawtext=text='${safeTitle}':fontsize=38:fontcolor=white:bordercolor=black:borderw=3:x=(w-text_w)/2:y=300,\
          drawtext=text='Was $${safeOriginal}':fontsize=50:fontcolor=gray:bordercolor=black:borderw=2:x=(w-text_w)/2:y=750,\
          drawtext=text='Now $${safePrice}':fontsize=80:fontcolor=yellow:bordercolor=black:borderw=3:x=(w-text_w)/2:y=850,\
          drawtext=text='@fndit_cheap':fontsize=36:fontcolor=white:bordercolor=black:borderw=2:x=30:y=1850,\
          drawtext=text='LINK IN BIO':fontsize=50:fontcolor=white:bordercolor=red:borderw=3:x=(w-text_w)/2:y=1750\
        " \
        -map "[darkened]" \
        -c:v libx264 -preset fast -crf 23 \
        -t 15 \
        -pix_fmt yuv420p \
        "${outputPath}"`;
    }

    console.log('Generating video...');
    await runCommand(ffmpegCmd);

    const videoBuffer = fs.readFileSync(outputPath);
    const videoBase64 = videoBuffer.toString('base64');

    fs.rmSync(tmpDir, { recursive: true, force: true });

    console.log('Video generated successfully! Size:', videoBuffer.length);
    res.json({ success: true, videoBase64, duration, size: videoBuffer.length });

  } catch (error) {
    console.error('Error:', error.message);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(e) {}
    res.status(500).json({ success: false, error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Video Generator running on port ${PORT}`));
