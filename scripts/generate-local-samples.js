#!/usr/bin/env node

/**
 * Generates a sample map JSON file from WAV/MP3 files in public/samples/
 * 
 * Usage: node scripts/generate-local-samples.js
 * 
 * This script scans public/samples/ and creates public/sample-banks/local.json
 * Files are organized by subdirectory (e.g., public/samples/piano/*.wav -> "piano": [...])
 */

const fs = require('fs')
const path = require('path')

const SAMPLES_DIR = path.join(__dirname, '..', 'public', 'samples')
const OUTPUT_FILE = path.join(__dirname, '..', 'public', 'sample-banks', 'local.json')

const AUDIO_EXTENSIONS = ['.wav', '.mp3', '.ogg', '.flac', '.aiff', '.aif', '.m4a']

function getAllFiles(dir, baseDir = dir) {
  const files = []
  const entries = fs.readdirSync(dir, { withFileTypes: true })

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    const relativePath = path.relative(baseDir, fullPath)

    if (entry.isDirectory()) {
      files.push(...getAllFiles(fullPath, baseDir))
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase()
      if (AUDIO_EXTENSIONS.includes(ext)) {
        files.push(relativePath.replace(/\\/g, '/')) // Normalize to forward slashes
      }
    }
  }

  return files
}

function generateSampleMap() {
  if (!fs.existsSync(SAMPLES_DIR)) {
    console.log(`Creating ${SAMPLES_DIR}...`)
    fs.mkdirSync(SAMPLES_DIR, { recursive: true })
  }

  const files = getAllFiles(SAMPLES_DIR)
  
  if (files.length === 0) {
    console.log('No audio files found in public/samples/')
    console.log('Add .wav or .mp3 files to get started!')
    
    // Create empty map
    const emptyMap = {
      "_base": "/samples/",
      "_note": "No local samples found. Add files to public/samples/ and run this script again."
    }
    
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(emptyMap, null, 2))
    console.log(`Created empty map at ${OUTPUT_FILE}`)
    return
  }

  // Group files by directory (first level)
  const sampleMap = {
    "_base": "/samples/",
  }

  for (const file of files) {
    const parts = file.split('/')
    const fileName = parts[parts.length - 1]
    const category = parts.length > 1 ? parts[0] : 'root'
    const relativePath = file

    if (!sampleMap[category]) {
      sampleMap[category] = []
    }

    sampleMap[category].push(relativePath)
  }

  // Sort each category's files
  for (const key in sampleMap) {
    if (key !== '_base' && Array.isArray(sampleMap[key])) {
      sampleMap[key].sort()
    }
  }

  // Ensure output directory exists
  const outputDir = path.dirname(OUTPUT_FILE)
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true })
  }

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(sampleMap, null, 2))
  
  const totalFiles = files.length
  const categories = Object.keys(sampleMap).filter(k => k !== '_base').length
  
  console.log(`✅ Generated sample map: ${totalFiles} files in ${categories} categories`)
  console.log(`   Output: ${OUTPUT_FILE}`)
  console.log(`   Categories: ${Object.keys(sampleMap).filter(k => k !== '_base').join(', ')}`)
}

try {
  generateSampleMap()
} catch (error) {
  console.error('Error generating sample map:', error)
  process.exit(1)
}

