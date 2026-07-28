import zlib from "node:zlib";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function channelsForColorType(colorType) {
  return {
    0: 1,
    2: 3,
    3: 1,
    4: 2,
    6: 4
  }[colorType] ?? 0;
}

function parsePng(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("Perceptual hashing requires a valid PNG.");
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let interlace = -1;
  let palette = null;
  const idat = [];
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > buffer.length) throw new Error("PNG chunk exceeds file length.");
    if (type === "IHDR") {
      width = buffer.readUInt32BE(start);
      height = buffer.readUInt32BE(start + 4);
      bitDepth = buffer[start + 8];
      colorType = buffer[start + 9];
      interlace = buffer[start + 12];
    } else if (type === "PLTE") {
      palette = buffer.subarray(start, end);
    } else if (type === "IDAT") {
      idat.push(buffer.subarray(start, end));
    } else if (type === "IEND") {
      break;
    }
    offset = end + 4;
  }
  const channels = channelsForColorType(colorType);
  if (!width || !height || !channels || !idat.length) {
    throw new Error("PNG lacks supported image data.");
  }
  if (bitDepth !== 8 || interlace !== 0) {
    throw new Error("Perceptual hashing supports non-interlaced 8-bit PNG images.");
  }
  if (width * height > 100_000_000) {
    throw new Error("PNG is too large for local perceptual hashing.");
  }
  const rowBytes = width * channels;
  const inflated = zlib.inflateSync(Buffer.concat(idat), {
    maxOutputLength: (rowBytes + 1) * height
  });
  if (inflated.length !== (rowBytes + 1) * height) {
    throw new Error("PNG decompressed data has an unexpected size.");
  }
  const pixels = Buffer.alloc(rowBytes * height);
  let inputOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[inputOffset];
    inputOffset += 1;
    const rowOffset = y * rowBytes;
    const previousOffset = (y - 1) * rowBytes;
    for (let x = 0; x < rowBytes; x += 1) {
      const raw = inflated[inputOffset + x];
      const left = x >= channels ? pixels[rowOffset + x - channels] : 0;
      const up = y > 0 ? pixels[previousOffset + x] : 0;
      const upLeft = y > 0 && x >= channels ? pixels[previousOffset + x - channels] : 0;
      let value;
      if (filter === 0) value = raw;
      else if (filter === 1) value = raw + left;
      else if (filter === 2) value = raw + up;
      else if (filter === 3) value = raw + Math.floor((left + up) / 2);
      else if (filter === 4) value = raw + paeth(left, up, upLeft);
      else throw new Error(`Unsupported PNG filter: ${filter}.`);
      pixels[rowOffset + x] = value & 0xff;
    }
    inputOffset += rowBytes;
  }
  return { width, height, colorType, channels, palette, pixels };
}

function luminanceAt(image, x, y) {
  const offset = (y * image.width + x) * image.channels;
  if (image.colorType === 0 || image.colorType === 4) return image.pixels[offset];
  if (image.colorType === 3) {
    const paletteOffset = image.pixels[offset] * 3;
    if (!image.palette || paletteOffset + 2 >= image.palette.length) return 0;
    return Math.round(
      image.palette[paletteOffset] * 0.299 +
      image.palette[paletteOffset + 1] * 0.587 +
      image.palette[paletteOffset + 2] * 0.114
    );
  }
  return Math.round(
    image.pixels[offset] * 0.299 +
    image.pixels[offset + 1] * 0.587 +
    image.pixels[offset + 2] * 0.114
  );
}

function sampledLuminance(image, sampleWidth = 9, sampleHeight = 9) {
  const samples = [];
  for (let y = 0; y < sampleHeight; y += 1) {
    const sourceY = Math.min(
      image.height - 1,
      Math.floor(((y + 0.5) * image.height) / sampleHeight)
    );
    for (let x = 0; x < sampleWidth; x += 1) {
      const sourceX = Math.min(
        image.width - 1,
        Math.floor(((x + 0.5) * image.width) / sampleWidth)
      );
      samples.push(luminanceAt(image, sourceX, sourceY));
    }
  }
  return samples;
}

export function pngDifferenceHash(buffer) {
  const image = parsePng(buffer);
  const values = sampledLuminance(image);
  let bits = 0n;
  let index = 0;
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      const left = values[y * 9 + x];
      const right = values[y * 9 + x + 1];
      if (left >= right) bits |= 1n << BigInt(index);
      index += 1;
    }
  }
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      const top = values[y * 9 + x];
      const bottom = values[(y + 1) * 9 + x];
      if (top >= bottom) bits |= 1n << BigInt(index);
      index += 1;
    }
  }
  return bits.toString(16).padStart(32, "0");
}

export function perceptualHashDistance(left, right) {
  if (!/^[a-f0-9]{32}$/i.test(String(left)) || !/^[a-f0-9]{32}$/i.test(String(right))) {
    throw new Error("Perceptual hashes must be 128-bit hexadecimal strings.");
  }
  let value = BigInt(`0x${left}`) ^ BigInt(`0x${right}`);
  let distance = 0;
  while (value) {
    distance += Number(value & 1n);
    value >>= 1n;
  }
  return distance;
}

export function findNearDuplicateImages(items, {
  maximumDistance = 6,
  comparable = () => true
} = {}) {
  const duplicates = [];
  for (let leftIndex = 0; leftIndex < items.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < items.length; rightIndex += 1) {
      const left = items[leftIndex];
      const right = items[rightIndex];
      if (!left?.perceptual_hash || !right?.perceptual_hash || !comparable(left, right)) continue;
      const distance = perceptualHashDistance(left.perceptual_hash, right.perceptual_hash);
      if (distance <= maximumDistance) {
        duplicates.push({
          left_id: left.id,
          right_id: right.id,
          distance,
          maximum_distance: maximumDistance
        });
      }
    }
  }
  return duplicates;
}
