import type { Express, Request, Response } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { exec, spawn, type ChildProcess } from "child_process";
import { promisify } from "util";
import path from "path";
import { fileURLToPath } from "url";
import { existsSync, unlinkSync, mkdirSync, readFileSync, copyFileSync, statSync } from "fs";
import { createRequire } from "module";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { GoogleAIFileManager } from "@google/generative-ai/server";
import pptxgen from "pptxgenjs";
import multer from "multer";
import os from "os";
import { uploadAudioToFirebase, checkAudioExists, downloadAudioFromFirebase, uploadImageToFirebase, uploadDocumentToFirebase, isFirebaseAvailable } from "./firebaseStorage";
import youtubedl from "youtube-dl-exec";
const require = createRequire(import.meta.url);
const pdf = require("pdf-parse");
const mammoth = require("mammoth");
const officeParser = require("officeparser");

const execAsync = promisify(exec);

// Process tracking: Map lectureId to child processes that can be killed
interface ProcessInfo {
  process: ChildProcess;
  type: "transcribe" | "download" | "youtube_transcribe";
  startTime: Date;
}

const activeProcesses = new Map<string, ProcessInfo[]>();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configure multer for file uploads
const uploadDir = path.join(os.tmpdir(), "lecture-assistant-uploads");
if (!existsSync(uploadDir)) {
  mkdirSync(uploadDir, { recursive: true });
}

const storageConfig = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname);
    cb(null, `audio-${uniqueSuffix}${ext}`);
  },
});

const upload = multer({
  storage: storageConfig,
  limits: {
    fileSize: 500 * 1024 * 1024, // 500MB max file size
  },
  fileFilter: (req, file, cb) => {
    // Accept audio and video files
    const allowedMimes = [
      "audio/mpeg",
      "audio/mp3",
      "audio/wav",
      "audio/webm",
      "audio/ogg",
      "audio/m4a",
      "video/mp4",
      "video/webm",
      "video/ogg",
      "video/quicktime",
      "audio/x-m4a",
      "audio/mp4",
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "application/vnd.ms-powerpoint"
    ];

    if (allowedMimes.includes(file.mimetype) || file.originalname.match(/\.(pdf|docx|doc|pptx|ppt)$/i)) {
      cb(null, true);
    } else {
      cb(new Error(`Invalid file type. Allowed types: audio, video, PDF, Word, PPT.`));
    }
  },
});

/**
 * Robustly clean and sanitize AI-generated JSON strings.
 * Handles markdown backticks, surrounding text, literal control characters,
 * and double-escaping of backslashes (frequent issue with LaTeX).
 */
function cleanGeminiJson(rawText: string): string {
  if (!rawText) return "{}";
  
  // 1. Remove markdown block markers if present
  let cleaned = rawText.replace(/```json\n?/gi, "").replace(/```\n?/g, "").trim();
  
  // 2. Extract the first {...} or [...] block to ignore any pre/post commentary
  const jsonMatch = cleaned.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (jsonMatch) {
    cleaned = jsonMatch[0];
  }

  // 3. Proactively fix common JSON SyntaxErrors
  // First, fix literal control characters inside strings (newlines, tabs, etc.)
  // These cause "Bad control character in string literal" errors.
  let sanitized = cleaned.replace(/"([^"\\]|\\.)*"/g, (match) => {
    return match
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t");
  });

  // 4. Handle LaTeX backslashes correctly for JSON parsing.
  // Gemini often returns \frac which becomes an invalid escape seq in JSON.
  // We need to turn \ into \\, but NOT if it's already an escape like \" or \n.
  // We use a multi-pass approach to protect valid escapes.
  const strictCleaned = sanitized
    .replace(/\\/g, "___BS_VAL___")               // Replace all backslashes with a unique token
    .replace(/___BS_VAL___(?=["\\])/g, "\\")      // Restore structural JSON escapes: ONLY \" and \\
    .replace(/___BS_VAL___/g, "\\\\");             // Double all other backslashes (mostly LaTeX paths)

  return strictCleaned;
}

export async function registerRoutes(
  httpServer: Server,
  app: Express,
): Promise<Server> {
  // put application routes here
  // prefix all routes with /api

  // Serve the local uploads directory for fallback images/documents when Firebase fails
  const localImagesDir = path.join(process.cwd(), "uploads", "images");
  const localDocumentsDir = path.join(process.cwd(), "uploads", "documents");
  if (!existsSync(localImagesDir)) {
    mkdirSync(localImagesDir, { recursive: true });
  }
  if (!existsSync(localDocumentsDir)) {
    mkdirSync(localDocumentsDir, { recursive: true });
  }
  const expressModule = require("express");
  app.use("/uploads", expressModule.static(path.join(process.cwd(), "uploads")));

  // --- AI Prompts ---
  const quizPrompt = `You are an expert academic examiner. Create a comprehensive high-quality quiz based on the provided lecture content.
Return a JSON object with this structure:
{
  "lectureTitle": "Title of the Lecture",
  "questions": [
     {
      "id": 1,
      "type": "multiple-choice", // Support: multiple-choice, true-false, open-ended
      "text": "Detailed question text?",
      "options": ["Option A", "Option B", "Option C", "Option D"],
      "correctAnswer": "Option A",
      "explanation": "Detailed explanation.",
      "reference": {
        "source_type": "uploaded_content",
        "location": "Timestamp (e.g. 05:20) or Slide number",
        "concept": "Name of the concept"
      }
    }
  ]
}
CRITICAL RULES:
1. GENERATE EXACTLY 30 QUESTIONS IN TOTAL. 
2. QUESTION DISTRIBUTION: 14 Multiple-Choice, 14 True/False, 2 Essay (open-ended).
{{difficulty_rules}}
4. FOR GENERAL KNOWLEDGE QUESTIONS: Set "reference.source_type" to "related_topic" and "reference.location" to "General Knowledge".
5. MATHEMATICAL CONTENT: If the lecture contains math or numbers, make at least 10 MCQs "Numerical Problems" (مسايل) and ensure both Essay questions are multi-step problems requiring a final numerical answer.
6. NUMERICAL FLAGS: For math problems, set "is_numerical": true and provide the exact final result in "numerical_answer".
7. LANGUAGE: If the transcript is in Arabic, generate the quiz in ARABIC.
8. LATEX: Wrap ALL mathematical formulas, variables, or chemical symbols in LaTeX format ($...$ for inline, $$...$$ for blocks).
9. REFERENCE: For lecture questions, identify the exact location (Timestamp or Slide).
10. Ensure the output is STRICTLY valid JSON.`;

  const evaluationPrompt = `You are an academic grader. Evaluate the student's answer to the provided question.
Return a JSON object with this structure:
{
  "score": number (0 to 100),
  "feedback": "Encouraging and detailed feedback explaining the score",
  "isCorrect": boolean,
  "missedKeywords": ["keyword1", "keyword2"]
}
Context:
Question: {{question}}
Student Answer: {{userAnswer}}
Correct Reference Answer: {{correctAnswer}}
Expected Keywords: {{expectedKeywords}}

RULES:
1. Be fair but strict on technical accuracy.
2. NUMERICAL VALIDATION: If is_numerical is true, the student MUST provide the correct final numerical result. If the number matches the correctAnswer's result, give full credit regardless of the explanation wording.
3. If the answer is partially correct (and not a pure numerical problem), give partial credit.
4. Respond in the SAME language as the question.`;

  const summaryPrompt = `You are a professional editorial curator and academic summarizer. Generate a high-fidelity structured summary for the provided lecture content.
  
  Your response MUST be a JSON object with this exact structure:
  {
    "mainTitle": "Catchy short professional title (e.g. Neural Networks Deep Dive)",
    "subTitle": "1-sentence architectural overview of the core concepts discussed.",
    "keyConcepts": [
       { "title": "Concept Name", "description": "Detailed 2-3 sentence explanation with key terms bolded." }
    ],
    "definitions": [
       { "term": "Technical Term", "definition": "Clear, concise academic definition." }
    ],
    "takeawaySummary": "A punchy, short summary (1-2 paragraphs) of the main value of the lecture.",
    "takeawayPoints": ["Short punchy rule-of-thumb point (e.g. Weights = Knowledge)", "Point 2", "Point 3"]
  }

  CRITICAL RULES:
  1. Preserve all mathematical formulas in LaTeX format ($...$).
  2. Bold important terms inside descriptions.
  3. Respond in the same language as the input lecture.
  4. Ensure the output is STRICTLY valid JSON.`;

  const conceptMapPrompt = `Analyze the lecture content and create a structured concept map showing relationships between key topics.
Return a JSON object with this structure:
{
  "nodes": [
    { "id": "1", "label": "Main Topic", "type": "main" },
    { "id": "2", "label": "Sub-concept", "type": "sub" }
  ],
  "edges": [
    { "from": "1", "to": "2", "label": "related to" }
  ]
}
RULES:
1. Use the same language as the input.
2. Ensure nodes represent distinct concepts.
3. Ensure edges clearly define the relationship.`;

  // Helper for Gemini requests with retry logic and model fallback
  const callGeminiWithRetry = async (genAI: any, prompt: string | any[], preferredModel = "gemini-2.5-flash", retries = 3, temperature?: number, responseMimeType?: string) => {
    const modelsToTry = ["gemini-2.5-flash"];
    let lastError: any;

    let currentModelIndex = 0;

    for (let i = 0; i < retries; i++) {
      // Try next model if previous one hard failed
      if (currentModelIndex >= modelsToTry.length) currentModelIndex = 0;
      const modelName = modelsToTry[currentModelIndex];
      try {
        console.log(`[API] Attempting with model: ${modelName} (Attempt ${i + 1}/${retries}), Temp: ${temperature ?? 'default'}`);
        const config: any = temperature !== undefined ? { temperature } : {};
        if (responseMimeType) {
          config.responseMimeType = responseMimeType;
        }
        const model = genAI.getGenerativeModel({ model: modelName, generationConfig: config });
        const result = await Promise.race([
          model.generateContent(prompt),
          new Promise((_, reject) => setTimeout(() => reject(new Error(`Gemini generateContent timed out after 120 seconds`)), 120000))
        ]) as any;
        const response = await result.response;
        return response.text().trim();
      } catch (error: any) {
        lastError = error;

        // Handle 429 (Rate Limit / Quota) with backoff and model change
        if ((error.status === 429 || error.message?.includes("429")) && i < retries - 1) {
          const waitTime = 3000 * Math.pow(2, i);
          console.log(`[API] Gemini Rate Limited (${modelName}). Waiting ${waitTime}ms and switching to fallback model...`);
          currentModelIndex++; // Advance to next model instead of spamming the rate-limited one
          await new Promise(resolve => setTimeout(resolve, waitTime));
          continue;
        }

        // Handle 404 or other failures by switching model immediately
        console.error(`[API] Gemini Error with ${modelName}:`, error.message);
        currentModelIndex++;
        if (currentModelIndex < modelsToTry.length) {
          console.log(`[API] Falling back to model: ${modelsToTry[currentModelIndex]}...`);
        } else {
          console.log(`[API] Retrying with same model...`);
        }
        continue;
      }
    }
    throw lastError;
  };

  const bulkPruneAndAnalyzeImages = async (imagePaths: string[], genAI: any) => {
    if (imagePaths.length === 0) return [];
    
    console.log(`[API] Bulk analyzing ${imagePaths.length} images for pedagogical relevance...`);
    const batch = imagePaths.slice(0, 30); // Max 30
    const parts: any[] = [
      {
        text: `Analyze these images from a lecture presentation.
        For each image (provided in order), categorize its pedagogical relevance.
        
        CATEGORIES:
        1. "crucial": High-value educational visuals (complex diagrams, charts, graphs, technical drawings, mathematical proofs, or clear unique lecture-specific illustrations).
        2. "informative": Regular slides that contain useful structured information, bullet points, or reference images that are NOT crucial diagrams but are still worth keeping in a gallery.
        3. "garbage": STRICTLY IGNORE AND CATEGORIZE AS GARBAGE: Title slides, empty slides, transition slides (e.g., "Any Questions?", "Break"), presenter biographies/photos, generic company/brand logos, "Thank You" slides, or slides that are completely blurred/unreadable.
        
        Return a JSON array exactly matching the number of input images: 
        [
          { 
            "relevance": "crucial" | "informative" | "garbage", 
            "details": {
               "title": "Short descriptive title",
               "description": "Brief pedagogical explanation",
               "type": "Diagram" | "Slide" | "Handwritten",
               "bullets": ["Key point 1", "Key point 2"],
               "keyTerms": ["Term 1", "Term 2"]
            }
          },
          ...
        ]
        Return ONLY valid JSON.`
      }
    ];

    for (const imgPath of batch) {
      if (existsSync(imgPath)) {
        const data = readFileSync(imgPath);
        parts.push({
          inlineData: {
            data: data.toString('base64'),
            mimeType: 'image/jpeg'
          }
        });
      }
    }

    try {
      const responseRaw = await callGeminiWithRetry(genAI, parts, "gemini-2.5-flash", 1, 0.1, "application/json");
      let cleaned = responseRaw.replace(/```json\n?/gi, "").replace(/```\n?/g, "").trim();
      return JSON.parse(cleaned);
    } catch (e) {
      console.warn("[API] Bulk image analysis failed:", e);
      return batch.map(() => ({ relevance: "informative", details: null }));
    }
  };

  const isLikelyDecorativeImage = (imgPath: string): boolean => {
    try {
      const fileName = path.basename(imgPath).toLowerCase();
      const size = statSync(imgPath).size;

      // Tiny assets are usually logos/icons/decorative separators.
      if (size < 30000) return true;

      // Common decorative naming patterns in slide templates.
      if (/(logo|icon|watermark|background|bg-|separator|shape|theme|master)/i.test(fileName)) {
        return true;
      }

      return false;
    } catch {
      return false;
    }
  };

  // Helper to upload file to Gemini for vision processing
  const uploadToGemini = async (filePath: string, mimeType: string) => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY not set");

    const fileManager = new GoogleAIFileManager(apiKey);
    const uploadResult = await fileManager.uploadFile(filePath, {
      mimeType,
      displayName: path.basename(filePath),
    });

    const file = uploadResult.file;
    console.log(`[API] Uploaded file to Gemini: ${file.uri} (${file.state})`);

    // Wait for file to be active
    let fileState = file.state;
    while (fileState === "PROCESSING") {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const fileStatus = await fileManager.getFile(file.name);
      fileState = fileStatus.state;
      console.log(`[API] File processing state: ${fileState}`);
    }

    if (fileState !== "ACTIVE") {
      throw new Error(`Gemini file processing failed with state: ${fileState}`);
    }

    return file;
  };

  /**
   * Stop processing endpoint - kills all processes for a lecture
   */
  app.post("/api/lecture/:lectureId/stop", async (req: Request, res: Response) => {
    try {
      const { lectureId } = req.params;

      if (!lectureId) {
        return res.status(400).json({ error: "Lecture ID is required" });
      }

      const processes = activeProcesses.get(lectureId);

      if (!processes || processes.length === 0) {
        console.log(`[API] No active processes found for lecture: ${lectureId}`);
        return res.json({ message: "No active processes to stop", stopped: 0 });
      }

      let stoppedCount = 0;
      for (const procInfo of processes) {
        try {
          if (procInfo.process && !procInfo.process.killed) {
            console.log(`[API] Killing process for lecture ${lectureId}, type: ${procInfo.type}`);
            procInfo.process.kill('SIGTERM');

            // Force kill after 2 seconds if still running
            setTimeout(() => {
              if (procInfo.process && !procInfo.process.killed) {
                console.log(`[API] Force killing process for lecture ${lectureId}`);
                procInfo.process.kill('SIGKILL');
              }
            }, 2000);

            stoppedCount++;
          }
        } catch (error: any) {
          console.error(`[API] Error killing process:`, error);
        }
      }

      // Remove from tracking
      activeProcesses.delete(lectureId);

      console.log(`[API] Stopped ${stoppedCount} process(es) for lecture: ${lectureId}`);
      res.json({ message: `Stopped ${stoppedCount} process(es)`, stopped: stoppedCount });
    } catch (error: any) {
      console.error("[API] Error stopping processes:", error);
      res.status(500).json({ error: "Failed to stop processes" });
    }
  });

  /**
   * Health check endpoint
   */
  app.get("/api/health", async (req: Request, res: Response) => {
    try {
      // Check Python availability
      const venvPython = path.join(__dirname, "..", "venv", "bin", "python3");
      const pythonExecutable = process.platform === "win32" ? "python" : "python3";
      const pythonCmd = process.env.PYTHON_CMD || (existsSync(venvPython) ? venvPython : pythonExecutable);

      res.json({
        status: "healthy",
        timestamp: new Date().toISOString(),
        python: pythonCmd,
        node: process.version,
        cuda: process.env.CUDA_VISIBLE_DEVICES || "not set",
      });
    } catch (error: any) {
      res.status(500).json({
        status: "unhealthy",
        error: error.message,
      });
    }
  });

  /**
   * YouTube video info extraction endpoint (title, thumbnail, duration, etc.)
   * Uses Python script with yt-dlp (scripts/get_video_info.py)
   */
  app.post("/api/youtube/info", async (req: Request, res: Response) => {
    try {
      const { videoId } = req.body;

      if (!videoId || typeof videoId !== "string") {
        return res.status(400).json({ error: "Video ID is required" });
      }

      console.log(`[API] Fetching video info for: ${videoId}`);

      try {
        console.log(`[API] Info: using python command configuration`);
        // Allow custom python command via env, fallback to venv python, then python/python3
        const venvPython = path.join(__dirname, "..", "venv", "bin", "python3");
        const pythonExecutable = process.platform === "win32" ? "python" : "python3";
        const pythonCmd = process.env.PYTHON_CMD || (existsSync(venvPython) ? venvPython : pythonExecutable);
        const pythonScript = path.join(__dirname, "scripts", "get_video_info.py");
        const { stdout, stderr } = await execAsync(
          `${pythonCmd} "${pythonScript}" "${videoId}"`,
          { timeout: 60000 } // 1 minute timeout for info
        );

        if (stderr) {
          console.error(`[API] Python stderr (video info):`, stderr);
        }

        const result = JSON.parse(stdout.trim());

        if (!result.success) {
          return res.status(404).json({
            error: result.error || "Failed to fetch video information",
            details: result.details || "Could not retrieve video details from YouTube.",
          });
        }

        console.log(`[API] Video info fetched successfully:`, {
          title: result.title,
          duration: result.duration,
          channel: result.channelName,
        });

        res.json({
          videoId: result.videoId,
          title: result.title,
          thumbnailUrl: result.thumbnailUrl,
          duration: result.duration,
          channelName: result.channelName,
          durationSeconds: result.durationSeconds,
        });
      } catch (pythonError: any) {
        console.error("[API] Error calling Python script for video info:", pythonError);
        res.status(500).json({
          error: "Failed to fetch video info via Python script",
          details: pythonError.message || "Unknown error",
        });
      }
    } catch (error: any) {
      console.error("[API] Error in video info endpoint:", error);
      res.status(500).json({ error: "Failed to fetch video info" });
    }
  });

  /**
   * YouTube transcript extraction endpoint
   * Uses Python script scripts/get_transcript.py (youtube_transcript_api)
   */
  app.post("/api/youtube/transcript", async (req: Request, res: Response) => {
    try {
      const { videoId, startTime, endTime } = req.body;

      if (!videoId || typeof videoId !== "string") {
        return res.status(400).json({ error: "Video ID is required" });
      }

      const startTimeSeconds = startTime !== undefined && startTime !== null ? parseFloat(startTime) : null;
      const endTimeSeconds = endTime !== undefined && endTime !== null ? parseFloat(endTime) : null;

      console.log(`[API] Fetching transcript for video: ${videoId}${startTimeSeconds !== null ? ` (from ${startTimeSeconds}s)` : ''}${endTimeSeconds !== null ? ` (to ${endTimeSeconds}s)` : ''}`);

      try {
        console.log(`[API] Transcript: starting process...`);
        console.log(`[API] Calling Python script to fetch transcript...`);
        const pythonScript = path.join(__dirname, "scripts", "get_transcript.py");

        // Build command with optional time parameters
        // Use venv python if available, otherwise fallback to python/python3
        const venvPython = path.join(__dirname, "..", "venv", "bin", "python3");
        const pythonExecutable = process.platform === "win32" ? "python" : "python3";
        const pythonCmd = process.env.PYTHON_CMD || (existsSync(venvPython) ? venvPython : pythonExecutable);
        let command = `${pythonCmd} "${pythonScript}" "${videoId}"`;
        if (startTimeSeconds !== null) {
          command += ` "${startTimeSeconds}"`;
        }
        if (endTimeSeconds !== null) {
          command += ` "${endTimeSeconds}"`;
        }

        console.log(`[API] Executing command: ${command}`);
        const { stdout, stderr } = await execAsync(command, { timeout: 180000 }); // 3 minutes timeout for transcript

        if (stderr) {
          console.error(`[API] Python stderr:`, stderr);
        }

        console.log(`[API] Python stdout length: ${stdout.length}`);
        console.log(`[API] Python stdout preview: ${stdout.substring(0, 100)}`);

        const result = JSON.parse(stdout.trim());

        if (!result.success) {
          return res.status(404).json({
            error: result.error || "No transcript available for this video",
            details:
              result.details || "The video may not have captions enabled.",
          });
        }

        const fullTranscript = result.transcript;

        if (!fullTranscript || fullTranscript.length === 0) {
          return res.status(404).json({
            error: "No transcript text found",
            details: "The transcript exists but contains no text.",
          });
        }

        console.log(
          `[API] Successfully fetched transcript (${fullTranscript.length} characters, ${result.wordCount} words, language: ${result.language})`,
        );

        res.json({
          transcript: fullTranscript,
          wordCount: result.wordCount,
          characterCount: fullTranscript.length,
          language: result.language,
          transcriptChunks: result.chunks || undefined,
        });
        return;
      } catch (pythonError: any) {
        console.error("[API] Error calling Python script for transcript:", pythonError);

        let errorMessage = "Failed to extract transcript";
        if (
          pythonError.message?.includes("No module named 'youtube_transcript_api'")
        ) {
          errorMessage =
            "Python 'youtube_transcript_api' not installed. Please run 'pip install youtube-transcript-api'.";
        } else if (pythonError.message?.includes("No transcript available")) {
          errorMessage =
            "No transcript available for this video. The video may not have captions.";
        } else if (pythonError.message?.includes("Transcripts are disabled")) {
          errorMessage = "Transcripts are disabled for this video by the creator.";
        }

        res.status(500).json({
          error: errorMessage,
          details: pythonError.message,
        });
      }
    } catch (error: any) {
      console.error("[API] Error in transcript endpoint:", error);
      res.status(500).json({ error: "Failed to extract transcript" });
    }
  });

  /**
   * YouTube audio download and transcription endpoint using Faster Whisper
   * Downloads audio from YouTube and converts it to text using Whisper
   * Saves audio files to Firebase Storage for future use
   */
  app.post("/api/youtube/transcribe", async (req: Request, res: Response) => {
    let downloadedFilePath: string | null = null;
    let downloadProcess: ChildProcess | null = null;
    let transcribeProcess: ChildProcess | null = null;
    // Get userId from request body or auth (if available)
    const userId = req.body.userId || (req as any).user?.uid || "anonymous";
    const lectureId = req.body.lectureId as string | undefined;

    try {
      const { videoId, startTime, endTime, modelSize = "large-v3", language, device = "cuda", videoTitle, channelName } = req.body;

      if (!videoId || typeof videoId !== "string") {
        return res.status(400).json({ error: "Video ID is required" });
      }

      const startTimeSeconds = startTime !== undefined && startTime !== null ? parseFloat(startTime) : null;
      const endTimeSeconds = endTime !== undefined && endTime !== null ? parseFloat(endTime) : null;

      // Auto-detect Arabic from video title or channel name
      let detectedLanguage = language;
      if (!language || language === "auto") {
        const hasArabicInTitle = videoTitle && /[\u0600-\u06FF]/.test(videoTitle);
        const hasArabicInChannel = channelName && /[\u0600-\u06FF]/.test(channelName);
        if (hasArabicInTitle || hasArabicInChannel) {
          detectedLanguage = "ar";
          console.log(`[API] Auto-detected Arabic language from ${hasArabicInTitle ? 'title' : 'channel'}`);
        }
      }

      console.log(`[API] Downloading and transcribing YouTube video: ${videoId}`);
      console.log(`[API] Time range: ${startTimeSeconds || 0}s - ${endTimeSeconds || "end"}`);
      console.log(`[API] Model: ${modelSize}, Language: ${detectedLanguage || "auto"}, Device: ${device}`);

      // Check if audio already exists in Firebase Storage (only if no time range specified)
      let audioUrl: string | null = null;
      if (startTimeSeconds === null && endTimeSeconds === null) {
        try {
          audioUrl = await checkAudioExists(userId, videoId);
          if (audioUrl) {
            console.log(`[API] Audio file found in Firebase Storage: ${audioUrl}`);
            // Download from Firebase to temp file for transcription
            const tempFile = path.join(os.tmpdir(), `firebase-${videoId}-${Date.now()}.mp3`);
            await downloadAudioFromFirebase(userId, videoId, tempFile);
            downloadedFilePath = tempFile;
          }
        } catch (firebaseError) {
          console.warn(`[API] Could not check Firebase Storage, proceeding with YouTube download:`, firebaseError);
        }
      }

      try {
        // Get Python command (needed for both download and transcription)
        const venvPython = path.join(__dirname, "..", "venv", "bin", "python3");
        const pythonExecutable = process.platform === "win32" ? "python" : "python3";
        const pythonCmd = process.env.PYTHON_CMD || (existsSync(venvPython) ? venvPython : pythonExecutable);

        let geminiFileUri: string | undefined;
        let geminiFileMimeType: string | undefined;
        const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

        // Step 1: Download video from YouTube (if not found in Firebase)
        if (!downloadedFilePath) {
          downloadedFilePath = path.join(os.tmpdir(), `youtube-vid-${videoId}-${Date.now()}.mp4`);

          console.log(`[API] Downloading YouTube video using youtube-dl-exec for Vision processing...`);

          const dlOptions: any = {
            format: 'best[height<=360]/best',
            output: downloadedFilePath,
            noCheckCertificates: true,
            noWarnings: true,
            preferFreeFormats: true,
          };

          if (startTimeSeconds !== null || endTimeSeconds !== null) {
            const startStr = startTimeSeconds !== null ? startTimeSeconds.toString() : '0';
            const endStr = endTimeSeconds !== null ? endTimeSeconds.toString() : 'inf';
            dlOptions.downloadSections = `*${startStr}-${endStr}`;
          }

          try {
            await youtubedl(videoUrl, dlOptions);
            console.log(`[API] Video downloaded successfully to ${downloadedFilePath}`);

            // Optionally upload to Firebase Storage if no time range
            if (startTimeSeconds === null && endTimeSeconds === null && userId !== "anonymous") {
              try {
                audioUrl = await uploadAudioToFirebase(downloadedFilePath, userId as string, videoId as string);
                console.log(`[API] Media uploaded to Firebase Storage: ${audioUrl}`);
              } catch (uploadError) {
                console.warn(`[API] Could not upload to Firebase Storage (acceptable):`, uploadError);
              }
            }
          } catch (dlError: any) {
            console.error(`[API] youtube-dl-exec failed:`, dlError);
            return res.status(500).json({
              error: "Failed to download media from YouTube",
              details: dlError.message || "Could not download file.",
            });
          }
        }

        // Upload to Gemini for Vision API (optional but highly recommended for math)
        if (process.env.GEMINI_API_KEY && existsSync(downloadedFilePath)) {
          try {
            console.log(`[API] Proactively uploading YouTube video to Gemini for future Vision tasks...`);
            const fileRecord = await uploadToGemini(downloadedFilePath, "video/mp4");
            geminiFileUri = fileRecord.uri;
            geminiFileMimeType = fileRecord.mimeType;
            console.log(`[API] YouTube video uploaded to Gemini: ${geminiFileUri}`);
          } catch (uploadError) {
            console.warn("[API] Proactive YouTube upload to Gemini failed, continuing without Vision support:", uploadError);
          }
        }

        // Step 2: Transcribe (either API or GPU/Whisper)
        let transcript = "";
        let transcribeResult: any = { success: true };

        if (req.body.mode === "api") {
          console.log(`[API] Transcribing YouTube audio with Gemini API...`);
          const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
          
          // If already uploaded for vision, use that. Otherwise, upload now.
          let finalUri = geminiFileUri;
          let finalMimeType = geminiFileMimeType;
          
          if (!finalUri && existsSync(downloadedFilePath)) {
            const fileRecord = await uploadToGemini(downloadedFilePath, "video/mp4");
            finalUri = fileRecord.uri;
            finalMimeType = fileRecord.mimeType;
          }

          if (finalUri) {
            const prompt = `Transcribe the speech in this file accurately. ${detectedLanguage ? `The language is ${detectedLanguage}.` : 'Detect the language automatically, preferring Arabic if detected.'} Return ONLY the transcription text, nothing else.`;
            transcript = await callGeminiWithRetry(genAI, [
              { fileData: { fileUri: finalUri, mimeType: finalMimeType || "video/mp4" } },
              { text: prompt }
            ]);
            
            transcribeResult = {
              success: true,
              transcript,
              wordCount: transcript.split(/\s+/).length,
              characterCount: transcript.length,
              language: detectedLanguage || "auto"
            };
          } else {
            throw new Error("Failed to provide audio/video to Gemini for transcription");
          }
        } else {
          // GPU Mode (Local Whisper)
          const transcribeScript = path.join(__dirname, "scripts", "transcribe_audio.py");
          const transcribeArgs = [transcribeScript, downloadedFilePath, modelSize];
          if (detectedLanguage) {
            transcribeArgs.push(detectedLanguage);
          } else {
            transcribeArgs.push("None");
          }
          transcribeArgs.push(device);

          console.log(`[API] Transcribing audio with Whisper (Local GPU)...`);

          // Use spawn to track the process
          transcribeProcess = spawn(pythonCmd, transcribeArgs, {
            stdio: ['ignore', 'pipe', 'pipe']
          });

          // Track process if lectureId is provided
          if (lectureId) {
            if (!activeProcesses.has(lectureId)) {
              activeProcesses.set(lectureId, []);
            }
            activeProcesses.get(lectureId)!.push({
              process: transcribeProcess,
              type: "youtube_transcribe",
              startTime: new Date()
            });
          }

          let transcribeStdout = '';
          let transcribeStderr = '';

          transcribeProcess.stdout?.on('data', (data) => {
            transcribeStdout += data.toString();
          });

          transcribeProcess.stderr?.on('data', (data) => {
            transcribeStderr += data.toString();
          });

          // Wait for transcription to complete
          await new Promise<void>((resolve, reject) => {
            transcribeProcess!.on('close', (code) => {
              if (code !== 0) {
                reject(new Error(`Transcribe process exited with code ${code}. ${transcribeStderr}`));
              } else {
                resolve();
              }
            });

            transcribeProcess!.on('error', (error) => {
              reject(error);
            });
          });

          if (transcribeStderr) {
            console.error(`[API] Python stderr (transcription):`, transcribeStderr);
          }

          transcribeResult = JSON.parse(transcribeStdout.trim());
          transcript = transcribeResult.transcript;
        }

        // Remove transcribe process from tracking on success
        if (lectureId && transcribeProcess) {
          const processes = activeProcesses.get(lectureId);
          if (processes) {
            const index = processes.findIndex(p => p.process === transcribeProcess);
            if (index !== -1) {
              processes.splice(index, 1);
              if (processes.length === 0) {
                activeProcesses.delete(lectureId);
              }
            }
          }
        }

        if (!transcribeResult.success) {
          return res.status(500).json({
            error: transcribeResult.error || "Transcription failed",
            details: transcribeResult.details || "Could not transcribe audio file.",
          });
        }

        if (!transcript || transcript.length === 0) {
          return res.status(404).json({
            error: "No transcript text found",
            details: "The transcription completed but contains no text.",
          });
        }

        console.log(
          `[API] Successfully transcribed YouTube audio (${transcript.length} characters, ${transcribeResult.wordCount} words, language: ${transcribeResult.language})`,
        );

        res.json({
          transcript,
          wordCount: transcribeResult.wordCount,
          characterCount: transcribeResult.characterCount || transcript.length,
          language: transcribeResult.language,
          audioUrl: audioUrl || undefined, 
          sourceUrl: videoUrl, // Use the original YouTube URL as sourceUrl
          geminiFileUri,
          geminiFileMimeType,
          transcriptChunks: transcribeResult.chunks || undefined,
        });
      } catch (pythonError: any) {
        // Remove processes from tracking on error
        if (lectureId) {
          const processes = activeProcesses.get(lectureId);
          if (processes) {
            if (downloadProcess) {
              const index = processes.findIndex(p => p.process === downloadProcess);
              if (index !== -1) {
                processes.splice(index, 1);
              }
            }
            if (transcribeProcess) {
              const index = processes.findIndex(p => p.process === transcribeProcess);
              if (index !== -1) {
                processes.splice(index, 1);
              }
            }
            if (processes.length === 0) {
              activeProcesses.delete(lectureId);
            }
          }
        }

        console.error("[API] Error in YouTube transcription:", pythonError);

        let errorMessage = "Failed to transcribe YouTube audio";
        if (pythonError.message?.includes("No module named 'yt_dlp'")) {
          errorMessage = "Python 'yt-dlp' not installed. Please run 'pip install yt-dlp'.";
        } else if (pythonError.message?.includes("No module named 'faster_whisper'")) {
          errorMessage = "Python 'faster-whisper' not installed. Please run 'pip install faster-whisper'.";
        }

        res.status(500).json({
          error: errorMessage,
          details: pythonError.message,
        });
      }
    } catch (error: any) {
      // Remove processes from tracking on error
      if (lectureId) {
        const processes = activeProcesses.get(lectureId);
        if (processes) {
          if (downloadProcess) {
            const index = processes.findIndex(p => p.process === downloadProcess);
            if (index !== -1) {
              processes.splice(index, 1);
            }
          }
          if (transcribeProcess) {
            const index = processes.findIndex(p => p.process === transcribeProcess);
            if (index !== -1) {
              processes.splice(index, 1);
            }
          }
          if (processes.length === 0) {
            activeProcesses.delete(lectureId);
          }
        }
      }

      console.error("[API] Error in YouTube transcription endpoint:", error);
      res.status(500).json({ error: "Failed to transcribe YouTube audio" });
    } finally {
      // Clean up downloaded file
      if (downloadedFilePath && existsSync(downloadedFilePath)) {
        try {
          unlinkSync(downloadedFilePath);
          console.log(`[API] Cleaned up downloaded file: ${downloadedFilePath}`);
        } catch (cleanupError) {
          console.error(`[API] Error cleaning up file: ${cleanupError}`);
        }
      }
    }
  });

  /**
   * Audio file transcription endpoint using Faster Whisper
   * Accepts audio/video files and converts them to text transcript
   */
  app.post("/api/audio/transcribe", upload.single("audio"), async (req: Request, res: Response) => {
    let uploadedFilePath: string | null = null;
    let originalFilename: string = "unknown";
    let childProcess: ChildProcess | null = null;
    let sourceUrl: string | undefined;
    const lectureId = req.body.lectureId as string | undefined;

    try {
      if (!req.file) {
        return res.status(400).json({ error: "No audio file uploaded" });
      }

      uploadedFilePath = req.file.path;
      originalFilename = req.file.originalname;

      let geminiFileUri: string | undefined;
      let geminiFileMimeType: string | undefined;

      // We no longer convert PPT to PDF because Gemini 1.5 natively supports PPTX files
      // and we can extract images via zipfile locally if needed.

      const isVideoInfo = req.file?.mimetype?.startsWith("video/") || originalFilename.match(/\.(mp4|webm|ogg|mov)$/i);
      const isDocumentInfo = req.file?.mimetype === "application/pdf" || originalFilename.match(/\.(pdf|pptx?|docx?|doc)$/i);
      const isVisualFile = isVideoInfo || isDocumentInfo;

      // Persist original visual files so split-screen viewer always has a resolvable URL.
      // 1) Try Firebase public URL.
      // 2) Fallback to local /uploads/documents URL when Firebase is unavailable/fails.
      // 3) For PPTX files without Firebase, convert to PDF locally so browser can display them natively.
      if (isVisualFile && existsSync(uploadedFilePath!)) {
        try {
          if (isFirebaseAvailable && isFirebaseAvailable()) {
            const userId = req.body.userId || (req as any).user?.uid || "anonymous";
            sourceUrl = await uploadDocumentToFirebase(uploadedFilePath!, userId, lectureId || "temp");
            console.log(`[API] Original document uploaded to Firebase: ${sourceUrl}`);
          } else {
            throw new Error("Firebase is unavailable");
          }
        } catch (uploadError) {
          try {
            const ext = path.extname(originalFilename) || path.extname(uploadedFilePath!);
            const baseName = path.basename(originalFilename, path.extname(originalFilename)) || "document";
            const safeBaseName = baseName.replace(/[^a-zA-Z0-9-_]/g, "_");
            const timestamp = Date.now();
            
            // For PPTX files, convert to PDF locally when Firebase is unavailable
            // This allows browser's native PDF viewer to display the file instead of external viewers
            if (ext && ext.match(/\.pptx?$/i)) {
              const pdfFileName = `${safeBaseName}-${timestamp}.pdf`;
              const pdfDest = path.join(process.cwd(), "uploads", "documents", pdfFileName);
              
              try {
                const venvPython = path.join(__dirname, "..", "venv", "bin", "python3");
                const pythonExecutable = process.platform === "win32" ? "python" : "python3";
                const pythonCmd = process.env.PYTHON_CMD || (existsSync(venvPython) ? venvPython : pythonExecutable);
                const pptxConvertScript = path.join(__dirname, "scripts", "convert_pptx.py");
                
                console.log(`[API] Converting PPTX to PDF locally for viewer: ${uploadedFilePath} -> ${pdfDest}`);
                const { stdout, stderr } = await execAsync(`"${pythonCmd}" "${pptxConvertScript}" "${uploadedFilePath}" "${pdfDest}"`);
                
                if (stderr) console.warn(`[API] PPTX conversion stderr:`, stderr);
                if (stdout.includes("SUCCESS")) {
                  sourceUrl = `/uploads/documents/${pdfFileName}`;
                  console.log(`[API] PPTX converted to PDF locally for viewer: ${sourceUrl}`);
                } else {
                  throw new Error("PPTX conversion failed");
                }
              } catch (convertError) {
                console.warn("[API] PPTX to PDF conversion failed, falling back to original file:", convertError);
                // Fallback to original PPTX file if conversion fails
                const localFileName = `${safeBaseName}-${timestamp}${ext || ""}`;
                const localDest = path.join(process.cwd(), "uploads", "documents", localFileName);
                copyFileSync(uploadedFilePath!, localDest);
                sourceUrl = `/uploads/documents/${localFileName}`;
              }
            } else {
              // For non-PPTX files, just copy locally
              const localFileName = `${safeBaseName}-${timestamp}${ext || ""}`;
              const localDest = path.join(process.cwd(), "uploads", "documents", localFileName);
              copyFileSync(uploadedFilePath!, localDest);
              sourceUrl = `/uploads/documents/${localFileName}`;
            }
            console.log(`[API] Original document saved locally for viewer: ${sourceUrl}`);
          } catch (localFallbackError) {
            console.warn("[API] Local document fallback failed:", localFallbackError);
          }

          console.warn("[API] Early document upload to Firebase failed:", uploadError);
        }
      }

      if (isVisualFile && process.env.GEMINI_API_KEY && existsSync(uploadedFilePath)) {
        try {
          console.log(`[API] Proactively uploading visual file ${originalFilename} to Gemini for future Vision tasks...`);
          // Note: Gemini natively supports PDFs and PPTXs.
          let mimeType = req.file?.mimetype || "video/mp4";
          if (originalFilename.match(/\.pptx$/i)) mimeType = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
          if (originalFilename.match(/\.pdf$/i)) mimeType = "application/pdf";

          // Wrap the upload in a timeout to prevent hanging the API for too long
          const uploadPromise = uploadToGemini(uploadedFilePath, mimeType);
          const timeoutPromise = new Promise((_, reject) => {
             // Increase timeout to 60 seconds for larger PDFs and videos
             setTimeout(() => reject(new Error("Gemini file upload timed out after 60 seconds")), 60000);
          });

          const fileRecord = await Promise.race([uploadPromise, timeoutPromise]) as any;
          geminiFileUri = fileRecord.uri;
          geminiFileMimeType = fileRecord.mimeType;
        } catch (uploadError: any) {
          console.warn(`[API] Proactive upload to Gemini failed or timed out (${uploadError.message}), continuing without Vision formulas support.`);
        }
      }

      // Extract parameters from FormData (multer puts them in req.body)
      const isAudioVideo = isVideoInfo || req.file?.mimetype?.startsWith("audio/") || originalFilename.match(/\.(mp3|wav|m4a|aac)$/i);
      
      // Default to large-v3 for best quality (especially on GPU/RunPod)
      // BUT if we are on CPU, default to 'base' for much better speed (tiny is too low quality, small is still slow)
      let defaultModel = "large-v3";
      let device = req.body.device || "cuda";
      if (device === "gpu") device = "cuda";
      
      if (device === "cpu" && !req.body.modelSize) {
        defaultModel = "base"; 
      }
      
      const modelSize = req.body.modelSize || defaultModel;
      const language = req.body.language || undefined;

      if (isAudioVideo) {
        console.log(`[API] Whisper Configuration:`, {
          modelSize,
          device,
          language: language || "auto-detect",
          fileSize: `${(req.file.size / 1024 / 1024).toFixed(2)} MB`,
          lectureId: lectureId || "none"
        });
      }

      console.log(`[API] Processing file: ${originalFilename} (original size: ${req.file.size} bytes)`);

      const fileExt = path.extname(originalFilename).toLowerCase();
      let transcript = "";
      let documentPageCount: number | undefined;

      // Handle Document Files
      let extractedImages: { url: string, relevance?: string, description: string }[] = [];
      let transcriptChunks: any[] = [];

      if (fileExt === ".pdf") {
        try {
          const venvPython = path.join(__dirname, "..", "venv", "bin", "python3");
          const pythonExecutable = process.platform === "win32" ? "python" : "python3";
          const pythonCmd = process.env.PYTHON_CMD || (existsSync(venvPython) ? venvPython : pythonExecutable);
          const extractPdfScript = path.join(__dirname, "scripts", "extract_pdf_content.py");

          console.log(`[API] Executing: ${pythonCmd} ${extractPdfScript} ${uploadedFilePath}`);
          const { stdout, stderr } = await execAsync(`"${pythonCmd}" "${extractPdfScript}" "${uploadedFilePath}"`);

          if (stderr) {
            console.error(`[API] Python stderr (PDF extraction):`, stderr);
          }

          let result;
          try {
            // To handle potential encoding issues or extra print statements from python
            let cleanStdout = stdout.substring(stdout.indexOf('{'));
            result = JSON.parse(cleanStdout);
          } catch (e) {
            console.error("[API] Failed to parse PyMuPDF output:", stdout);
            throw new Error("Invalid output from PyMuPDF script");
          }

          if (!result.success) {
            throw new Error(`PDF extraction failed: ${result.error}`);
          }

          transcript = result.transcript;
          if (typeof result.page_count === "number" && Number.isFinite(result.page_count)) {
            documentPageCount = result.page_count;
          }

          // Store chunks with their associated images for better display
          transcriptChunks = result.chunks || [];

          // Upload extracted images to Firebase Storage
          if (result.images && result.images.length > 0 && lectureId) {
            const geminiApiKey = process.env.GEMINI_API_KEY;
            const genAI = geminiApiKey ? new GoogleGenerativeAI(geminiApiKey) : null;
            
            let prunedResults = [];
            if (genAI) {
              try {
                prunedResults = await bulkPruneAndAnalyzeImages(result.images, genAI);
              } catch (e) {
                console.warn("[API] Bulk pruning failed, using all images", e);
              }
            }

            const userId = req.body.userId || (req as any).user?.uid || "anonymous";
            const canUseFirebase = isFirebaseAvailable && isFirebaseAvailable();
            console.log(`[API] Processing extracted images (${canUseFirebase ? 'Firebase' : 'Local Only'})...`);

            // Map local paths to uploaded URLs for chunk image resolution
            const pathToUrlMap: Record<string, string> = {};

            for (let i = 0; i < result.images.length; i++) {
              const imgPath = result.images[i];
              const pruningInfo = prunedResults[i];

              if (isLikelyDecorativeImage(imgPath)) {
                if (existsSync(imgPath)) unlinkSync(imgPath);
                continue;
              }

              // Filter out garbage slides (intros, empty, logos) if AI analysis was successful
              if (pruningInfo && pruningInfo.relevance === "garbage") {
                if (existsSync(imgPath)) unlinkSync(imgPath);
                continue;
              }

              try {
                let url = "";
                if (canUseFirebase) {
                    url = await uploadImageToFirebase(imgPath, userId, lectureId);
                } else {
                    throw new Error("Firebase disabled");
                }
                extractedImages.push({ 
                  url, 
                  relevance: pruningInfo?.relevance || "informative",
                  description: pruningInfo?.details ? JSON.stringify(pruningInfo.details) : "" 
                });
                pathToUrlMap[imgPath] = url;
              } catch (err) {
                try {
                  const fileName = path.basename(imgPath);
                  const localDest = path.join(process.cwd(), "uploads", "images", fileName);
                  copyFileSync(imgPath, localDest);
                  const localUrl = `/uploads/images/${fileName}`;
                  extractedImages.push({ 
                    url: localUrl, 
                    relevance: pruningInfo?.relevance || "informative",
                    description: pruningInfo?.details ? JSON.stringify(pruningInfo.details) : "" 
                  });
                  pathToUrlMap[imgPath] = localUrl;
                } catch (fallbackErr) {
                  console.error(`[API] Local fallback failed for image ${imgPath}:`, fallbackErr);
                }
              }
              if (existsSync(imgPath)) unlinkSync(imgPath);
            }

            // Update chunk images from local paths to uploaded URLs
            transcriptChunks = transcriptChunks.map(chunk => ({
              ...chunk,
              images: (chunk.images || [])
                .map((imgPath: string) => pathToUrlMap[imgPath] || imgPath)
                .filter((url: string) => url.startsWith('http') || url.startsWith('/')),
            }));
          }

          if (!transcript || transcript.trim().length < 50) {
            console.log(`[API] PDF text is empty or too short. Escalating to Gemini PDF extraction.`);
            throw new Error("PDF text too short or empty for standard parsing");
          }
        } catch (err) {
          console.log(`[API] PyMuPDF failed or returned little text. Escalating to Gemini PDF extraction.`);
          throw err;
        }
      } else if (fileExt === ".docx" || fileExt === ".doc") {
        const result = await mammoth.extractRawText({ path: uploadedFilePath });
        transcript = result.value;
      } else if (fileExt === ".pptx" || fileExt === ".ppt") {
        try {
          const data: any = await new Promise((resolve, reject) => {
            officeParser.parseOffice(uploadedFilePath, (data: any, err: any) => {
              if (err) return reject(err);
              resolve(data);
            });
          });

          const extractText = (obj: any): string => {
            if (!obj) return "";
            if (typeof obj === "string") return obj;
            if (Array.isArray(obj)) return obj.map(extractText).join("\n");

            let text = "";
            if (obj.text) text += obj.text + "\n";

            if (obj.children) text += extractText(obj.children);
            if (obj.content) text += extractText(obj.content);
            if (obj.data) text += extractText(obj.data);

            return text;
          };

          transcript = typeof data === 'string' ? data : extractText(data);
          transcript = transcript.replace(/\\n/g, "\n").replace(/\s+/g, " ").trim();

          // We ALSO extract images from PPTX using our new lightweight python zip extractor
          if (fileExt === ".pptx" && lectureId) {
            try {
              const venvPython = path.join(__dirname, "..", "venv", "bin", "python3");
              const pythonExecutable = process.platform === "win32" ? "python" : "python3";
              const pythonCmd = process.env.PYTHON_CMD || (existsSync(venvPython) ? venvPython : pythonExecutable);
              const pptxImagesScript = path.join(__dirname, "scripts", "extract_pptx_images.py");

              console.log(`[API] Executing: ${pythonCmd} ${pptxImagesScript} for images...`);
              const { stdout, stderr } = await execAsync(`"${pythonCmd}" "${pptxImagesScript}" "${uploadedFilePath}"`);

              if (stderr) console.warn(`[API] extract_pptx_images stderr:`, stderr);
              console.log(`[API] extract_pptx_images stdout:`, stdout);

              let cleanStdout = stdout.indexOf('{') >= 0 ? stdout.substring(stdout.indexOf('{')) : stdout;
              let result = JSON.parse(cleanStdout);

              if (result.success && result.images && result.images.length > 0) {
                const geminiApiKey = process.env.GEMINI_API_KEY;
                const genAI = geminiApiKey ? new GoogleGenerativeAI(geminiApiKey) : null;
                
                let prunedResults = [];
                if (genAI) {
                  try {
                    prunedResults = await bulkPruneAndAnalyzeImages(result.images, genAI);
                  } catch (e) {
                    console.warn("[API] Bulk pruning PPTX images failed", e);
                  }
                }

                const userId = req.body.userId || (req as any).user?.uid || "anonymous";
                const canUseFirebase = isFirebaseAvailable && isFirebaseAvailable();
                console.log(`[API] Uploading ${result.images.length} extracted PPTX images (${canUseFirebase ? 'Firebase' : 'Local Only'})...`);

                // Map local paths to uploaded URLs for chunk image resolution
                const pptxPathToUrlMap: Record<string, string> = {};

                for (let i = 0; i < result.images.length; i++) {
                  const imgPath = result.images[i];
                  const pruningInfo = prunedResults[i];

                  if (isLikelyDecorativeImage(imgPath)) {
                    if (existsSync(imgPath)) unlinkSync(imgPath);
                    continue;
                  }

                  // Filter out garbage slides
                  if (pruningInfo && pruningInfo.relevance === "garbage") {
                    if (existsSync(imgPath)) unlinkSync(imgPath);
                    continue;
                  }

                  try {
                    let url = "";
                    if (canUseFirebase) {
                        url = await uploadImageToFirebase(imgPath, userId, lectureId);
                    } else {
                        throw new Error("Firebase disabled");
                    }
                    extractedImages.push({ 
                      url, 
                      relevance: pruningInfo?.relevance || "informative",
                      description: pruningInfo?.details ? JSON.stringify(pruningInfo.details) : "" 
                    });
                    pptxPathToUrlMap[imgPath] = url;
                  } catch (err) {
                    try {
                      const fileName = path.basename(imgPath);
                      const localDest = path.join(process.cwd(), "uploads", "images", fileName);
                      copyFileSync(imgPath, localDest);
                      const localUrl = `/uploads/images/${fileName}`;
                      extractedImages.push({ 
                        url: localUrl, 
                        relevance: pruningInfo?.relevance || "informative",
                        description: pruningInfo?.details ? JSON.stringify(pruningInfo.details) : "" 
                      });
                      pptxPathToUrlMap[imgPath] = localUrl;
                    } catch (fallbackErr) {
                      console.error(`[API] Local fallback failed for PPTX image ${imgPath}:`, fallbackErr);
                    }
                  }
                  if (existsSync(imgPath)) unlinkSync(imgPath);
                }

                // Update PPTX chunk images from local paths to uploaded URLs
                if (result.chunks && result.chunks.length > 0) {
                  transcriptChunks = result.chunks.map((chunk: any) => ({
                    ...chunk,
                    images: (chunk.images || [])
                      .map((imgPath: string) => pptxPathToUrlMap[imgPath] || imgPath)
                      .filter((url: string) => url.startsWith('http') || url.startsWith('/')),
                  }));
                }
              } else {
                console.log(`[API] extraction returned no images or false success. Result:`, result);
              }

              if (typeof result.slide_count === "number" && Number.isFinite(result.slide_count)) {
                documentPageCount = result.slide_count;
              }
            } catch (err: any) {
              console.warn(`[API] Could not extract images from PPTX (non-fatal):`, err.message);
            }
          }
        } catch (err) {
          console.error("[API] Error parsing PPTX:", err);
          transcript = "";
        }
      }



      if (transcript && typeof transcript === 'string' && transcript.length > 0) {
        console.log(`[API] Successfully extracted text from document: ${originalFilename} (${transcript.length} chars)`);
        return res.json({
          transcript,
          wordCount: transcript.split(/\s+/).length,
          characterCount: transcript.length,
          language: "auto",
          geminiFileUri,
          geminiFileMimeType,
          extractedImages: extractedImages.length > 0 ? extractedImages : undefined,
          transcriptChunks: transcriptChunks.length > 0 ? transcriptChunks : undefined,
          sourceUrl,
          documentPageCount,
        });
      } else if (transcript) {
        console.log(`[API] Extracted data from document: ${originalFilename}`);
        return res.json({
          transcript: String(transcript),
          wordCount: 0,
          characterCount: 0,
          language: "auto",
          geminiFileUri,
          geminiFileMimeType,
          extractedImages: extractedImages.length > 0 ? extractedImages : undefined,
          transcriptChunks: transcriptChunks.length > 0 ? transcriptChunks : undefined,
          sourceUrl,
          documentPageCount,
        });
      }

      // If not a document, proceed with audio transcription
      if (req.body.mode === "api") {
        console.log(`[API] Transcribing file with Gemini API...`);
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
        
        let finalUri = geminiFileUri;
        let finalMimeType = geminiFileMimeType;
        
        if (!finalUri && uploadedFilePath) {
          const fileRecord = await uploadToGemini(uploadedFilePath, req.file.mimetype);
          finalUri = fileRecord.uri;
          finalMimeType = fileRecord.mimeType;
        }

        if (finalUri) {
          const prompt = `Transcribe the speech in this ${req.file.mimetype.startsWith('video') ? 'video' : 'audio'} file accurately. ${language ? `The language is ${language}.` : 'Detect the language automatically, preferring Arabic if detected.'} Return ONLY the transcription text, nothing else.`;
          const apiTranscript = await callGeminiWithRetry(genAI, [
            { fileData: { fileUri: finalUri, mimeType: finalMimeType || req.file.mimetype } },
            { text: prompt }
          ]);
          
          console.log(`[API] Successfully transcribed with Gemini (${apiTranscript.length} characters)`);
          
          return res.json({
            transcript: apiTranscript,
            wordCount: apiTranscript.split(/\s+/).length,
            characterCount: apiTranscript.length,
            language: language || "auto",
            geminiFileUri: finalUri,
            geminiFileMimeType: finalMimeType,
            extractedImages: extractedImages.length > 0 ? extractedImages : undefined,
            transcriptChunks: transcriptChunks.length > 0 ? transcriptChunks : undefined,
            sourceUrl,
            documentPageCount,
          });
        } else {
          throw new Error("Failed to provide file to Gemini for transcription");
        }
      }

      // GPU Mode (Local Whisper)
      console.log(`[API] Proceeding with Whisper transcription for: ${originalFilename}`);

      const pythonScript = path.join(__dirname, "scripts", "transcribe_audio.py");
      const venvPython = path.join(__dirname, "..", "venv", "bin", "python3");
      const pythonCmd = process.env.PYTHON_CMD || (existsSync(venvPython) ? venvPython : "python3");

      const args = [pythonScript, uploadedFilePath, modelSize];
      if (language) {
        args.push(language);
      } else {
        args.push("None");
      }
      args.push(device);

      console.log(`[API] Calling Python script for transcription...`);

      const pythonProcess = spawn(pythonCmd, args, {
        stdio: ['ignore', 'pipe', 'pipe']
      });

      childProcess = pythonProcess;

      if (lectureId) {
        if (!activeProcesses.has(lectureId)) {
          activeProcesses.set(lectureId, []);
        }
        const processes = activeProcesses.get(lectureId);
        if (processes) {
          processes.push({
            process: pythonProcess,
            type: "transcribe",
            startTime: new Date()
          });
        }
      }

      let stdout = '';
      let stderr = '';

      if (pythonProcess.stdout) {
        pythonProcess.stdout.on('data', (data) => {
          stdout += data.toString();
        });
      }

      if (pythonProcess.stderr) {
        pythonProcess.stderr.on('data', (data) => {
          stderr += data.toString();
        });
      }

      await new Promise<void>((resolve, reject) => {
        pythonProcess.on('close', (code) => {
          if (code !== 0) {
            reject(new Error(`Process exited with code ${code}. ${stderr}`));
          } else {
            resolve();
          }
        });
        pythonProcess.on('error', reject);
      });

      if (stderr) {
        console.error(`[API] Python stderr (transcription):`, stderr);
      }

      let result;
      try {
        result = JSON.parse(stdout.trim());
      } catch (parseError) {
        console.error(`[API] Failed to parse Python output: ${stdout}`);
        throw new Error(`Invalid JSON output from transcription script: ${stdout.substring(0, 100)}...`);
      }

      if (lectureId) {
        const processes = activeProcesses.get(lectureId);
        if (processes) {
          const index = processes.findIndex(p => p.process === pythonProcess);
          if (index !== -1) {
            processes.splice(index, 1);
            if (processes.length === 0) {
              activeProcesses.delete(lectureId);
            }
          }
        }
      }

      if (!result.success) {
        return res.status(500).json({
          error: result.error || "Transcription failed",
          details: result.details || "Could not transcribe audio file.",
        });
      }

      const audioTranscript = result.transcript;

      if (!audioTranscript || audioTranscript.length === 0) {
        return res.status(404).json({
          error: "No transcript text found",
          details: "The transcription completed but contains no text.",
        });
      }

      console.log(
        `[API] Successfully transcribed audio (${audioTranscript.length} characters, ${result.wordCount} words, language: ${result.language})`,
      );

      res.json({
        transcript: audioTranscript,
        wordCount: result.wordCount,
        characterCount: result.characterCount || audioTranscript.length,
        language: result.language,
        geminiFileUri,
        geminiFileMimeType,
        extractedImages: extractedImages.length > 0 ? extractedImages : undefined,
        transcriptChunks: (transcriptChunks.length > 0 ? transcriptChunks : result.chunks) || undefined,
        sourceUrl,
      });

    } catch (error: any) {
      // Check if we should try visual extraction for video/PDF files
      // This happens if Whisper/pdf-parse failed OR if we catch an error
      const isVideo = req.file?.mimetype?.startsWith("video/") || originalFilename.match(/\.(mp4|webm|ogg|mov)$/i);
      const isPdf = req.file?.mimetype === "application/pdf" || originalFilename.match(/\.pdf$/i);

      if ((isVideo || isPdf) && process.env.GEMINI_API_KEY) {
        console.log(`[API] Audio/Doc translation failed or irrelevant. Attempting Visual Extraction via Gemini...`);
        try {
          // Use the file we already have (uploadedFilePath)
          const mimeType = isPdf ? "application/pdf" : (req.file?.mimetype || "video/mp4");

          if (!uploadedFilePath || !existsSync(uploadedFilePath)) {
            throw new Error("File not found for visual extraction");
          }

          const fileRecord = await uploadToGemini(uploadedFilePath, mimeType);

          const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
          // Use the same model as the rest of the application
          const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

          const prompt = isPdf
            ? `You are an expert document transcriber and analyzer.
            Your task:
            1. Extract all text from this document accurately.
            2. Identify and describe ONLY the most important educational visuals (diagrams, complex charts, or unique technical drawings). 
               - SKIP non-essential images like logos, title pages, table of contents, or presenter names.
               - Describe these important visuals naturally within the flow of the text.
            3. *MATHEMATICS & FORMULAS*: EXHAUSTIVE EXTRACTION. Carefully extract EVERY mathematical equation, physical law, or algorithm using standard LaTeX format (e.g., $inline$ or $$block$$). If a concept is mentioned that has a known formula, include it. Be as comprehensive as possible.
            4. CRITICAL: Output ONLY the combined transcript text. No headers like "Text:".`
            : `You are an expert transcriber. 
            Your task:
            1. Extract all VISIBLE text from the slides or screen. 
            2. Focus ONLY on capturing and describing important educational diagrams, charts, or visual proofs. 
               - IGNORE empty slides, transition slides, title slides (with just names/titles), or generic decorative images.
            3. If there is audible speech, include that as well.
            4. Combine everything into a comprehensive, coherent lecture transcript.
            
            Important: Output ONLY the combined transcript text, do not add introductory remarks.`;


          const result = await model.generateContent([
            prompt,
            {
              fileData: {
                fileUri: fileRecord.uri,
                mimeType: fileRecord.mimeType,
              },
            },
          ]);

          const visualTranscript = result.response.text();
          console.log(`[API] Visual Extraction Successful (${visualTranscript.length} chars)`);

          // Return this as the transcript
          return res.json({
            transcript: visualTranscript,
            wordCount: visualTranscript.split(/\s+/).length,
            characterCount: visualTranscript.length,
            language: "auto",
            method: "visual_extraction",
            geminiFileUri: fileRecord.uri,
            geminiFileMimeType: fileRecord.mimeType,
            sourceUrl,
          });

        } catch (visualError: any) {
          console.error("[API] Visual extraction also failed:", visualError);
          // Fall through to original error response
        }
      }

      // Remove from tracking on error
      if (lectureId && childProcess) {
        const processes = activeProcesses.get(lectureId);
        if (processes) {
          const index = processes.findIndex(p => p.process === childProcess);
          if (index !== -1) {
            processes.splice(index, 1);
            if (processes.length === 0) {
              activeProcesses.delete(lectureId);
            }
          }
        }
      }

      console.error("[API] Error in audio transcription endpoint:", error);

      let errorMessage = "Failed to transcribe audio file";
      if (error.message?.includes("No module named 'faster_whisper'")) {
        errorMessage = "Python 'faster-whisper' not installed. Please run 'pip install faster-whisper'.";
      } else if (error.message?.includes("CUDA")) {
        errorMessage = "CUDA/GPU error. Try using device='cpu' instead.";
      }

      res.status(500).json({
        error: errorMessage,
        details: error.message
      });
    } finally {
      // Clean up uploaded file
      if (uploadedFilePath && existsSync(uploadedFilePath)) {
        try {
          unlinkSync(uploadedFilePath);
          console.log(`[API] Cleaned up temporary file: ${uploadedFilePath}`);
        } catch (cleanupError) {
          console.error(`[API] Error cleaning up file: ${cleanupError}`);
        }
      }
    }
  });


  /**
   * AI Summary endpoint
   * Priority:
   * 1) Gemini API (GEMINI_API_KEY)
   * 2) Ollama local model (OLLAMA_URL, OLLAMA_MODEL)
   * 3) Simple text-based fallback
   */
  app.post("/api/ai/summary", async (req: Request, res: Response) => {
    try {
      const { transcript, mode } = req.body as { transcript?: string; mode?: "gpu" | "api" };

      const isGpuMode = mode === "gpu";
      const isApiMode = mode === "api";

      console.log(`[API] Summary endpoint hit with mode: ${mode}`);
      if (!transcript || typeof transcript !== "string") {
        return res.status(400).json({ error: "Transcript is required" });
      }

      if (transcript.length < 100) {
        return res.status(400).json({
          error: "Transcript is too short to generate a summary",
        });
      }

      console.log(
        `[API] Generating AI summary for transcript (${transcript.length} characters)`,
      );

      // Priority 1: Gemini (Google Generative AI) - only if not forcing GPU/local-only
      const geminiApiKey = process.env.GEMINI_API_KEY;

      if (geminiApiKey && !isGpuMode) {
        try {
          console.log("[API] Using Gemini API for summary generation (unified call)");
          const genAI = new GoogleGenerativeAI(geminiApiKey);

          const hasArabic = /[\u0600-\u06FF]/.test(transcript);
          const language = hasArabic ? "Arabic" : "English";

          const fullPrompt = `${summaryPrompt}\n\nLECTURE CONTENT:\n${transcript.substring(0, 30000)}\n\nReturn ONLY valid JSON in ${language}.`;

          const aiResponseRaw = await callGeminiWithRetry(genAI, fullPrompt, "gemini-2.5-flash", 3, undefined, "application/json");

          let parsed;
          try {
            const strictCleaned = cleanGeminiJson(aiResponseRaw);
            parsed = JSON.parse(strictCleaned);
          } catch (e) {
            console.warn("[API] Failed to parse unified summary JSON, using regex fallback", e);
            const cleaned = aiResponseRaw.replace(/```json\n?/gi, "").replace(/```\n?/g, "").trim();

            // Regex fallback
            const extractField = (fieldName: string) => {
              const match = cleaned.match(new RegExp(`"${fieldName}"\\s*:\\s*(?:\\[(.*?)\\]|"([^"]*)")`, "is"));
              if (match) {
                if (match[1] !== undefined) {
                  const arrMatch = match[1].match(/"([^"]*)"/g);
                  return arrMatch ? arrMatch.map((s: string) => s.replace(/^"|"$/g, "").replace(/\\n/g, "\n")) : [];
                }
                return match[2] !== undefined ? match[2].replace(/\\n/g, "\n") : null;
              }
              return null;
            };

            const intro = extractField("introduction");
            const summ = extractField("summary");
            const kp = extractField("keypoints");

            if (!intro && !summ && (!kp || kp.length === 0)) {
              parsed = { introduction: "", summary: cleaned, keypoints: [] };
            } else {
              parsed = {
                introduction: typeof intro === "string" ? intro : "",
                summary: typeof summ === "string" ? summ : "",
                keypoints: Array.isArray(kp) ? kp : []
              };
            }
          }

          if (parsed.mainTitle || parsed.keyConcepts) {
            console.log(`[API] Gemini premium summary generated`);
            return res.json({
              summary: JSON.stringify(parsed),
              ...parsed
            });
          }

          const introSection = parsed.introduction ? `### ${headingIntro}\n${parsed.introduction}\n\n` : "";
          const keypointsSection = parsed.keypoints && parsed.keypoints.length > 0 ? `\n\n### ${headingPoints}\n${parsed.keypoints.map((p: string) => `- ${p}`).join("\n")}` : "";
          const combinedSummary = `${introSection}### ${headingSummary}\n${parsed.summary}${keypointsSection}`;

          console.log(`[API] Gemini unified summary generated (${combinedSummary.length} characters)`);
          return res.json({
            summary: combinedSummary,
            introduction: parsed.introduction,
            mainSummary: parsed.summary,
            keypoints: parsed.keypoints
          });
        } catch (geminiError: any) {
          console.error("[API] Gemini API error (unified summary):", geminiError);
        }
      }

      // Priority 2: Ollama (local AI model)
      const ollamaUrl = process.env.OLLAMA_URL || "http://localhost:11434";
      const ollamaModel = process.env.OLLAMA_MODEL || "qwen2.5:32b";
      try {
        if (isGpuMode || !geminiApiKey) {
          const ollamaCheck = await fetch(`${ollamaUrl}/api/tags`, { method: "GET", signal: AbortSignal.timeout(2000) });
          if (ollamaCheck.ok) {
            console.log(`[API] Using Ollama model for unified summary: ${ollamaModel}`);
            const hasArabic = /[\u0600-\u06FF]/.test(transcript);
            const language = hasArabic ? "Arabic" : "English";

            const ollamaPrompt = `${summaryPrompt}\n\nLECTURE CONTENT:\n${transcript.substring(0, 15000)}\n\nReturn ONLY valid JSON in ${language}.`;

            const ollamaResponse = await fetch(`${ollamaUrl}/api/generate`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ 
                model: ollamaModel, 
                prompt: ollamaPrompt + "\n\nReturn ONLY raw JSON.", 
                stream: false, 
                options: { temperature: 0.3, num_predict: 3000, num_ctx: 16384 } 
              }),
            });

            if (ollamaResponse.ok) {
              const ollamaData = await ollamaResponse.json();
              const aiResponse = (ollamaData.response || "").trim();
              const strictCleaned = cleanGeminiJson(aiResponse);
              const parsed = JSON.parse(strictCleaned);
              
              return res.json({
                summary: JSON.stringify(parsed),
                ...parsed
              });
            }
          }
        }
      } catch (ollamaError) {
        console.error("[API] Ollama summary generation failed:", ollamaError);
      }

      // Priority 3: Simple fallback
      const sentences = transcript.split(/[.!?\n]+/).map(s => s.trim()).filter(s => s.length > 30);
      const summaryText = sentences.slice(0, 5).join(". ") + ".";
      console.log(`[API] Simple fallback summary generated`);
      return res.json({ summary: summaryText });
    } catch (error: any) {
      console.error("[API] Error generating summary:", error);
      res.status(500).json({ error: "Failed to generate summary" });
    }
  });

  /**
   * Concept Map generation endpoint using AI
   * POST /api/ai/concept-map
   * Body: { "transcript": "...", "mode": "gpu" | "api" }
   * Returns: { "conceptMap": "JSON structure string" }
   */
  app.post("/api/ai/concept-map", async (req: Request, res: Response) => {
    try {
      const { transcript, flashcards, mode } = req.body as { transcript?: string; flashcards?: any[]; mode?: "gpu" | "api" };

      if (!transcript && !flashcards) {
        return res.status(400).json({ error: "Transcript or flashcards are required" });
      }

      console.log(`[API] Generating Concept Map using Flashcards or Transcript...`);
      const geminiApiKey = process.env.GEMINI_API_KEY;

      if (geminiApiKey && mode !== "gpu") {
        try {
          const genAI = new GoogleGenerativeAI(geminiApiKey);

          let contentSource = "";
          let hasArabic = false;

          if (flashcards && flashcards.length > 0) {
            const flashcardsText = JSON.stringify(flashcards);
            contentSource = `FLASHCARDS JSON DATA:\n${flashcardsText}\n\n`;
            hasArabic = /[\u0600-\u06FF]/.test(flashcardsText);
          } else {
            contentSource = `Transcript fragment:\n${transcript!.substring(0, 15000)}\n\n`;
            hasArabic = /[\u0600-\u06FF]/.test(transcript || "");
          }

          const ollamaUrl = process.env.OLLAMA_URL || "http://localhost:11434";
          const ollamaModel = process.env.OLLAMA_MODEL || "qwen2.5:32b";

          if (mode === "gpu") {
            try {
              console.log(`[API] Using Ollama model for concept map: ${ollamaModel}`);
              const ollamaResponse = await fetch(`${ollamaUrl}/api/generate`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  model: ollamaModel,
                  prompt: conceptMapPrompt + `\n\nContent to analyze:\n${contentSource}\n\nReturn ONLY the JSON object.`,
                  stream: false,
                  options: { temperature: 0.3, num_predict: 5000, num_ctx: 16384 }
                }),
              });
              if (ollamaResponse.ok) {
                const ollamaData = await ollamaResponse.json();
                const aiResponse = (ollamaData.response || "").trim();
                const strictCleaned = cleanGeminiJson(aiResponse);
                const parsed = JSON.parse(strictCleaned);
                return res.json({ conceptMap: JSON.stringify(parsed) });
              }
            } catch (ollamaError) {
              console.error("[API] Ollama concept map failed:", ollamaError);
              return res.status(500).json({ error: "Failed to generate concept map with GPU" });
            }
          }

          const conceptMapPrompt = `You are an expert academic tutor specializing in systems thinking and concept mapping for university-level engineering, science, and medical lectures.

Task: Given the source material below, create a comprehensive, hierarchical concept map that captures the core thesis and all key conceptual relationships in a clear, logical, educational structure.

CRITICAL RULES (Output Format):
1. You MUST return a SINGLE valid JSON object ONLY. No markdown highlighting like \`\`\`json. The JSON must have exactly three keys: "nodes", "edges", and "interactiveGuide".
2. "nodes": An array of objects. Each object MUST have:
   - "id": A unique string ID (e.g. "1", "2").
   - "label": The concept text. The language MUST match the predominant language of the source material. Include English terms alongside if necessary.
   - COMPREHENSIVENESS: Extract EVERYTHING important from the transcript. Make ANY number of necessary nodes to fully cover the material in detail. Go as deep and wide as needed to capture all nuances.
   - Maintain a clean, readable flow from core concepts down to specific details.
3. "edges": An array of objects. Each object MUST have:
   - "id": A unique string ID (e.g. "e1-2").
   - "source": The ID of the parent/origin node.
   - "target": The ID of the child/destination node.
   - "label": Write an explicit, concise explanation of EXACTLY how these two nodes are related on the arrow itself. It MUST explain the CAUSE, EFFECT, or REASON clearly using action verbs (e.g., "causes", "affects", "leads to", "increases", "because"). Write this label in the SAME language as the source material.
   - EXAMPLE CHAIN: "Climate Change" --[causes]--> "Global Warming" --[increases]--> "Temperature" --[affects]--> "Ice Melting". Follow this precise logical flow format.
   - STRICT VERTICAL TREE STRUCTURE: DO NOT create criss-crossing lines, multiple parents for one node, or complex webs. Keep it as a clean Top-Down (TD) vertical TREE to ensure arrows NEVER overlap visually. Every node (except the root) should have exactly ONE parent and be displayed below its parent.
4. NO FORMULAS OR NUMBERS in nodes. Extract ONLY pure qualitative theoretical concepts.
5. "interactiveGuide": An array of objects that MUST cover EVERY SINGLE NODE generated in the "nodes" array in a logical step-by-step teaching order. Each MUST have:
   - "node": The name of the concept (Must EXACTLY MATCH the label in the nodes array).
   - "explanation": Detailed academic explanation matching the predominant language of the source material (Arabic or English), explaining how these concepts connect to the parent and why they matter.
   - "spoken": Short spoken-style summary matching the predominant language of the source material.

Core Principles (Systems Thinking lens):
- Focus on interconnections, feedback loops, hierarchies, emergent properties.
- Identify leverage points, key definitions, causal chains.
- Prioritize conceptual understanding over rote facts.
- Eliminate redundancy; merge similar ideas.
- Ensure progressive complexity: simple foundations -> advanced applications.
- Make explanations precise, academic, but accessible for students.

Source Material:
${contentSource}
`;

          let aiResponse = await callGeminiWithRetry(genAI, conceptMapPrompt, "gemini-2.5-flash", 3, 0.3, "application/json");

          let finalPayload = aiResponse;
          try {
            const strictCleaned = cleanGeminiJson(aiResponse);
            const parsed = JSON.parse(strictCleaned);

            // Structure enforcing
            if (!parsed.nodes) parsed.nodes = [];
            if (!parsed.edges) parsed.edges = [];
            if (!parsed.interactiveGuide) parsed.interactiveGuide = [];

            finalPayload = JSON.stringify(parsed);
          } catch (e) {
            console.error("[API] Concept Map AI response was not valid JSON, applying fallback:", e);
            finalPayload = JSON.stringify({
              nodes: [{ id: "1", label: "Failed to parse map" }],
              edges: [],
              interactiveGuide: []
            });
          }

          console.log(`[API] Generated Concept Map payload (${finalPayload.length} chars)`);
          return res.json({ conceptMap: finalPayload });
        } catch (error: any) {
          console.error("[API] Failed to generate concept map via Gemini:", error);
        }
      }

      // Fallback simple concept map
      const fallbackConceptMap = JSON.stringify({
        nodes: [
          { id: "1", label: "Root Topic" },
          { id: "2", label: "Subtopic 1" },
          { id: "3", label: "Subtopic 2" }
        ],
        edges: [
          { id: "e1-2", source: "1", target: "2", label: "leads to" },
          { id: "e1-3", source: "1", target: "3", label: "explains" }
        ],
        interactiveGuide: []
      });
      return res.json({ conceptMap: fallbackConceptMap });
    } catch (error: any) {
      console.error("[API] Error in concept map endpoint:", error);
    }
  });

  /**
   * Image analysis endpoint using Gemini Vision
   * POST /api/ai/analyze-image
   * Body: { "imageUrl": "...", "transcript": "..." }
   * Returns: { "description": "..." }
   */
  app.post("/api/ai/analyze-image", async (req: Request, res: Response) => {
    try {
      const { imageUrl, transcript, language: forcedLanguage } = req.body;
      if (!imageUrl) {
        return res.status(400).json({ error: "Image URL is required" });
      }

      console.log(`[API] Analyzing image: ${imageUrl} (Language: ${forcedLanguage || 'auto'})`);
      const geminiApiKey = process.env.GEMINI_API_KEY;

      if (!geminiApiKey) {
        return res.status(500).json({ error: "Gemini API key not configured" });
      }

      // We need to get the image buffer
      let imageBuffer: Buffer;
      let mimeType = "image/jpeg";

      try {
        if (imageUrl.startsWith("http")) {
          const imgRes = await fetch(imageUrl);
          if (!imgRes.ok) throw new Error("Failed to fetch image");
          const arrayBuffer = await imgRes.arrayBuffer();
          imageBuffer = Buffer.from(arrayBuffer);
          mimeType = imgRes.headers.get("content-type") || "image/jpeg";
        } else if (imageUrl.startsWith("/uploads/")) {
          const localPath = path.join(process.cwd(), imageUrl);
          imageBuffer = readFileSync(localPath);
          mimeType = imageUrl.endsWith(".png") ? "image/png" : "image/jpeg";
        } else if (imageUrl.startsWith("data:")) {
          // Handle base64 data URI format: data:<mimeType>;base64,<data>
          const matches = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
          if (!matches) throw new Error("Invalid base64 data URI format");
          mimeType = matches[1];
          imageBuffer = Buffer.from(matches[2], "base64");
        } else {
          throw new Error("Invalid image URL format");
        }
      } catch (e: any) {
        console.error("[API] Failed to get image for analysis:", e);
        return res.status(400).json({ error: "Could not access image for analysis" });
      }

      const genAI = new GoogleGenerativeAI(geminiApiKey);
      const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

      const hasArabic = forcedLanguage === "ar" || (/[\u0600-\u06FF]/.test(transcript || "") && forcedLanguage !== "en");
      const outputLanguage = hasArabic ? "Arabic" : "English";

      const prompt = `Act as an expert academic assistant. Analyze this image accurately.
      
      QUALITY CONTROL RULE:
      - If this image is just a "Cover Page", "Table of Contents" (with no details), a "Blank Slide", a "Thank You" slide, or a purely decorative logo/image with NO educational value, you MUST return a very short description stating: "Decorative/Low-Value slide".
      - CRITICAL: If the image is a UI element, button (e.g., "Upload Lecture"), generic icon, or part of the application interface, mark it as "Decorative/Low-Value slide".
      - Focus ONLY on scientific, technical, or conceptual content (Charts, Diagrams, Formulas, Bullet lists of information).
      - Do NOT hallucinate content if the slide is mostly empty.

      Lecture context (for reference only, may not be relevant):
      ${transcript ? transcript.substring(0, 500) : "No context provided."}
      
      Return ONLY a valid JSON object with the following structure:
      {
        "title": "A short, descriptive title",
        "description": "A clear, concise academic explanation. If useless, state 'Decorative/Low-Value'.",
        "type": "Diagram" | "Slide" | "Handwritten" | "Photograph" | "Code" | "Decorative",
        "bullets": [ "Key insights" ],
        "keyTerms": [ "Key terms" ]
      }
      
      Ensure your response is ONLY in ${outputLanguage} and formatted neatly as JSON.`;

      const result = await model.generateContent([
        prompt,
        {
          inlineData: {
            data: imageBuffer.toString("base64"),
            mimeType: mimeType
          }
        }
      ]);

      let text = result.response.text().trim();
      let parsed = null;
      try {
        let cleanText = text.replace(/```json/gi, "").replace(/```/g, "").trim();
        const jsonMatch = cleanText.match(/\{[\s\S]*\}/);
        if (jsonMatch) cleanText = jsonMatch[0];
        parsed = JSON.parse(cleanText);
      } catch (e) {
        console.error("[API] Failed to parse JSON from Vision model", e);
        parsed = {
          title: "Image Analysis",
          description: text,
          type: "Diagram",
          bullets: [],
          keyTerms: []
        };
      }

      res.json({ description: JSON.stringify(parsed) });

    } catch (error: any) {
      console.error("[API] Error analyzing image:", error);
      res.status(500).json({ error: error.message || "Failed to analyze image" });
    }
  });

  /**
   * Category classification endpoint using AI
   * POST /api/ai/category
   * Body: { "title": "...", "transcript": "...", "summary": "...", "mode": "gpu" | "api" }
   * Returns: { "category": "science" | "technology" | ... }
   */
  app.post("/api/ai/category", async (req: Request, res: Response) => {
    try {
      const { title, transcript, summary, mode } = req.body as {
        title?: string;
        transcript?: string;
        summary?: string | string[];
        mode?: "gpu" | "api";
      };

      const isGpuMode = mode === "gpu";
      console.log(`[API] Category endpoint hit with mode: ${mode} `);

      if (!title && !transcript && !summary) {
        return res.status(400).json({
          error: "At least one of title, transcript, or summary is required",
        });
      }

      const content = [
        title || "",
        typeof summary === "string" ? summary : Array.isArray(summary) ? (summary as string[]).join(" ") : "",
        transcript || "",
      ]
        .filter(Boolean)
        .join("\n\n")
        .substring(0, 10000); // Limit content length

      console.log(`[API] Classifying lecture category(${content.length} characters)`);

      const categories = [
        "science",
        "technology",
        "mathematics",
        "medicine",
        "history",
        "art",
        "language",
        "business",
        "education",
        "other",
      ];

      const categoryDescriptions: Record<string, string> = {
        science: "Natural sciences: Physics, Chemistry, Biology, Scientific research, Experiments, Quantum mechanics, Molecular biology",
        technology: "Computer science and technology: Programming languages, Software development, Computer systems, Web development, Mobile apps, IT infrastructure. Only use this for technical/computer-related content, NOT for general topics that happen to mention technology.",
        mathematics: "Mathematical topics: Math, Calculus, Algebra, Geometry, Statistics, Equations, Mathematical proofs, Number theory",
        medicine: "Medical and health sciences: Medical practice, Health, Anatomy, Physiology, Surgery, Treatment, Clinical medicine, Healthcare",
        history: "Historical topics: Historical events, Ancient civilizations, Wars, Empires, Historical periods, Historical analysis",
        art: "Arts and creative fields: Visual arts, Painting, Sculpture, Design, Creative works, Aesthetics, Art history, Artistic techniques",
        language: "Languages and linguistics: Language learning, Linguistics, Literature, Writing, Poetry, Language structure, Translation",
        business: "Business and economics: Business management, Marketing, Finance, Economics, Entrepreneurship, Business strategy, Commerce",
        education: "Educational content: Teaching methods, Learning strategies, Academic courses, Educational theory, Pedagogy, Study techniques",
        other: "Any topic that does not clearly fit into the above categories",
      };

      const hasArabic = /[\u0600-\u06FF]/.test(content);
      const language = hasArabic ? "Arabic" : "English";

      // Priority 1: Ollama (GPU mode)
      const ollamaUrl = process.env.OLLAMA_URL || "http://localhost:11434";
      const ollamaModel = process.env.OLLAMA_MODEL || "qwen2.5:32b";

      if (isGpuMode) {
        try {
          console.log(`[API] Using Ollama model for category classification: ${ollamaModel} `);

          const prompt = `You are an expert content classifier.Analyze the following lecture content and classify it into ONE of these categories:

  Categories:
${categories
              .map(
                (cat) =>
                  `- ${cat}: ${categoryDescriptions[cat]}`,
              )
              .join("\n")
            }

Analyze the content and return ONLY the category name(one word) in lowercase.

    Content:
  Title: ${title || "N/A"}
  Summary: ${typeof summary === "string" ? summary.substring(0, 500) : Array.isArray(summary) ? (summary as string[]).join(" ").substring(0, 500) : "N/A"}
  Transcript: ${transcript?.substring(0, 2000) || "N/A"}

  Category: `;

          const ollamaResponse = await fetch(`${ollamaUrl}/api/generate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: ollamaModel,
              prompt: prompt,
              stream: false,
              options: {
                temperature: 0.3,
                top_p: 0.9,
                num_predict: 50,
              },
            }),
          });

          if (ollamaResponse.ok) {
            const ollamaData = await ollamaResponse.json();
            const text = ollamaData.response?.trim().toLowerCase() || "";

            let category = "other";
            for (const cat of categories) {
              if (text.includes(cat)) {
                category = cat;
                break;
              }
            }

            console.log(`[API] Ollama classified as: ${category} `);
            return res.json({ category });
          }
        } catch (error: any) {
          console.error("[API] Ollama classification error:", error);
          return res.status(500).json({ error: "Failed to classify category with GPU" });
        }
      }

      // Priority 2: Gemini API
      const geminiApiKey = process.env.GEMINI_API_KEY;

      if (geminiApiKey) {
        try {
          console.log("[API] Using Gemini API for category classification");
          const genAI = new GoogleGenerativeAI(geminiApiKey);
          const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
          
          const categoryPrompt = `You are an expert content classifier.Analyze the following and classify it into ONE of: ${categories.join(", ")}.
          Return ONLY the single word for the category in lowercase.
            Title: ${title || "N/A"}
          Content: ${transcript?.substring(0, 5000) || "N/A"}
          Category: `;

          const aiResponse = await callGeminiWithRetry(genAI, categoryPrompt, "gemini-2.5-flash");
          const text = aiResponse.toLowerCase();

          // Extract category from response - improved matching
          let category = "other";

          // Clean the response - remove common prefixes/suffixes
          const cleanedText = text
            .replace(/^(category|class|type|result|answer):?\s*/i, "")
            .replace(/\s*\.\s*$/, "")
            .trim()
            .toLowerCase();

          // First, try exact match at the start of cleaned response
          const firstWord = cleanedText.split(/\s+/)[0];
          if (categories.includes(firstWord)) {
            category = firstWord;
          } else {
            // Try to find category as a whole word in the response
            for (const cat of categories) {
              // Check if category appears as a whole word (not part of another word)
              const regex = new RegExp(`\\b${cat}\\b`, "i");
              if (regex.test(cleanedText)) {
                category = cat;
                break;
              }
            }
          }

          // Validate the category
          if (!categories.includes(category)) {
            console.warn(`[API] Invalid category "${category}" from Gemini, defaulting to "other"`);
            category = "other";
          }

          console.log(`[API] Gemini classified as: ${category} (from response: "${text.substring(0, 100)}...")`);
          return res.json({ category });
        } catch (error: any) {
          console.error("[API] Gemini classification error:", error);
        }
      }

      // Fallback: Return "other" if both AI methods fail
      console.log("[API] AI classification failed, using fallback");
      return res.json({ category: "other" });
    } catch (error: any) {
      console.error("[API] Category classification error:", error);
      return res.status(500).json({
        error: "Failed to classify lecture category",
        details: error.message,
      });
    }
  });

  /**
   * Quiz generation endpoint using Gemini API
   * POST /api/ai/quiz
   */
  app.post("/api/ai/quiz", async (req: Request, res: Response) => {
    try {
      const { transcript, title, quizLevel = "comprehensive", mode = "api" } = req.body;

      if ((!transcript || typeof transcript !== "string" || transcript.trim().length < 100) && !title) {
        return res.status(400).json({
          error: "Transcript or Title is required to generate quiz questions",
        });
      }

      console.log(`[API] Generating quiz (Level: ${quizLevel}, Engine: ${mode}) for transcript (${transcript?.length || 0} chars). Title: ${title}`);

      const isGpuMode = mode === "gpu";
      const ollamaUrl = process.env.OLLAMA_URL || "http://localhost:11434";
      const ollamaModel = process.env.OLLAMA_MODEL || "qwen2.5:32b";

      let difficultyRules = "3. CONTENT SOURCE: 25 questions from the lecture, 5 questions from General Academic Knowledge.";
      if (quizLevel === "advanced") {
        difficultyRules = "3. CONTENT SOURCE: 15 questions from the lecture, 15 questions from General Academic Knowledge.";
      } else if (quizLevel === "expert") {
        difficultyRules = "3. CONTENT SOURCE: 7 questions from the lecture, 23 questions from General Academic Knowledge.";
      }

      const fullPrompt = `${quizPrompt.replace("{{difficulty_rules}}", difficultyRules)}\n\nLECTURE CONTENT:\n${transcript || title}\n\nQUIZ LEVEL: ${quizLevel}\n\nReturn ONLY valid JSON.`;

      if (isGpuMode) {
        try {
          console.log(`[API] Using Ollama model for quiz generation: ${ollamaModel}`);
          const ollamaResponse = await fetch(`${ollamaUrl}/api/generate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: ollamaModel,
              prompt: fullPrompt + "\n\nReturn ONLY the JSON object, no other text.",
              stream: false,
              options: { temperature: 0.3, num_predict: 8000, num_ctx: 32768 }
            }),
          });

          if (ollamaResponse.ok) {
            const ollamaData = await ollamaResponse.json();
            const aiResponse = (ollamaData.response || "").trim();
            const strictCleaned = cleanGeminiJson(aiResponse);
            const parsedResponse = JSON.parse(strictCleaned);
            return res.json(parsedResponse);
          }
        } catch (ollamaError) {
          console.error("[API] Ollama quiz generation failed:", ollamaError);
          return res.status(500).json({ error: "Failed to generate quiz with GPU" });
        }
      }

      const geminiApiKey = process.env.GEMINI_API_KEY;
      if (!geminiApiKey) {
        return res.status(500).json({ error: "Gemini API key not configured" });
      }
      const genAI = new GoogleGenerativeAI(geminiApiKey);

      // Enable retries (3) to allow fallback to other models
      const aiResponse = await callGeminiWithRetry(genAI, fullPrompt, "gemini-2.5-flash", 3, undefined, "application/json");

      let parsedResponse;
      try {
        const strictCleaned = cleanGeminiJson(aiResponse);
        parsedResponse = JSON.parse(strictCleaned);
      } catch (parseError) {
        console.error("[API] Failed to parse JSON from Gemini quiz response:", parseError);
        return res.status(500).json({ 
          error: "Failed to generate valid quiz JSON",
          details: String(parseError)
        });
      }

      return res.json(parsedResponse);
    } catch (error: any) {
      console.error("[API] Error generating quiz:", error);
      res.status(500).json({ error: "Failed to generate quiz questions" });
    }
  });

  /**
   * Evaluate Essay Answer endpoint
   * POST /api/ai/evaluate-answer
   */
  app.post("/api/ai/evaluate-answer", async (req: Request, res: Response) => {
    try {
      const { question, userAnswer, correctAnswer, expectedKeywords = [], is_numerical = false, mode = "api" } = req.body;

      if (!question || !userAnswer) {
        return res.status(400).json({ error: "Missing required fields" });
      }

      const isGpuMode = mode === "gpu";
      const ollamaUrl = process.env.OLLAMA_URL || "http://localhost:11434";
      const ollamaModel = process.env.OLLAMA_MODEL || "qwen2.5:32b";

      const fullPrompt = evaluationPrompt
        .replace("{{question}}", question)
        .replace("{{userAnswer}}", userAnswer)
        .replace("{{correctAnswer}}", correctAnswer || "N/A")
        .replace("{{expectedKeywords}}", expectedKeywords.join(", ") || "N/A");

      if (isGpuMode) {
        try {
          console.log(`[API] Using Ollama model for evaluation: ${ollamaModel}`);
          const ollamaResponse = await fetch(`${ollamaUrl}/api/generate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: ollamaModel,
              prompt: fullPrompt + "\n\nReturn ONLY raw JSON.",
              stream: false,
              options: { temperature: 0.1, num_predict: 1000 }
            }),
          });
          if (ollamaResponse.ok) {
            const ollamaData = await ollamaResponse.json();
            const aiResponse = (ollamaData.response || "").trim();
            const strictCleaned = cleanGeminiJson(aiResponse);
            const parsedResponse = JSON.parse(strictCleaned);
            return res.json(parsedResponse);
          }
        } catch (ollamaError) {
          console.error("[API] Ollama evaluation failed:", ollamaError);
          return res.status(500).json({ error: "Failed to evaluate with GPU" });
        }
      }

      const geminiApiKey = process.env.GEMINI_API_KEY;
      if (!geminiApiKey) {
        return res.status(500).json({ error: "Gemini API key not configured" });
      }
      const genAI = new GoogleGenerativeAI(geminiApiKey);

      const aiResponse = await callGeminiWithRetry(genAI, fullPrompt, "gemini-2.5-flash", 2);

      let parsedResponse;
      try {
        const strictCleaned = cleanGeminiJson(aiResponse);
        parsedResponse = JSON.parse(strictCleaned);
      } catch (e) {
        console.error("[API] Failed to parse evaluation response:", e);
        return res.status(500).json({ error: "Failed to parse evaluation response", details: String(e) });
      }

      return res.json(parsedResponse);
    } catch (error: any) {
      console.error("[API] Error evaluating answer:", error);
      res.status(500).json({ error: "Failed to evaluate answer" });
    }
  });

  /**
   * AI Flashcards endpoint
   * POST /api/ai/flashcards
   * Body: { "transcript": "...", "mode": "api" | "gpu" }
   * Returns: { "flashcards": [{ "id": 1, "term": "...", "definition": "..." }] }
   */
  app.post("/api/ai/flashcards", async (req: Request, res: Response) => {
    try {
      const { transcript, mode } = req.body as { transcript?: string; mode?: "gpu" | "api" };

      const isGpuMode = mode === "gpu";

      if (!transcript || typeof transcript !== "string" || transcript.trim().length < 200) {
        return res.status(400).json({
          error: "Transcript is too short to generate flashcards (minimum 200 characters)",
        });
      }

      console.log(`[API] Generating flashcards for transcript (${transcript.length} characters)`);

      const ollamaUrl = process.env.OLLAMA_URL || "http://localhost:11434";
      const ollamaModel = process.env.OLLAMA_MODEL || "qwen2.5:32b";

      // Priority 1: Ollama (GPU mode)
      if (isGpuMode) {
        try {
          console.log(`[API] Using Ollama model for flashcards: ${ollamaModel}`);
          const hasArabic = /[\u0600-\u06FF]/.test(transcript);
          const language = hasArabic ? "Arabic" : "English";

          const ollamaResponse = await fetch(`${ollamaUrl}/api/generate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: ollamaModel,
              prompt: `Create 10-15 flashcards in JSON format: { "flashcards": [{ "id": 1, "term": "...", "definition": "..." }] }. Use ${language}. Transcript: ${transcript.substring(0, 15000)}`,
              stream: false,
              options: { temperature: 0.4, num_predict: 3000, num_ctx: 16384 },
            }),
          });

          if (ollamaResponse.ok) {
            const ollamaData = await ollamaResponse.json();
            const aiResponse = (ollamaData.response || "").trim();
            const strictCleaned = cleanGeminiJson(aiResponse);
            const parsedResponse = JSON.parse(strictCleaned);
            return res.json(parsedResponse);
          }
        } catch (ollamaError) {
          console.error("[API] Ollama flashcards failed:", ollamaError);
          return res.status(500).json({ error: "Failed to generate flashcards with GPU" });
        }
      }

      // Priority 2: Gemini API
      const geminiApiKey = process.env.GEMINI_API_KEY;
      if (geminiApiKey) {
        try {
          console.log("[API] Using Gemini API for flashcards generation");
          const genAI = new GoogleGenerativeAI(geminiApiKey);
          const flashcardPrompt = `Create 10-15 study flashcards in JSON format: { "flashcards": [{ "id": 1, "term": "...", "definition": "..." }] }. Use the same language as transcript. Transcript: ${transcript.substring(0, 20000)}`;
          const aiResponse = await callGeminiWithRetry(genAI, flashcardPrompt, "gemini-2.5-flash", 3, undefined, "application/json");
          const strictCleaned = cleanGeminiJson(aiResponse);
          const parsedResponse = JSON.parse(strictCleaned);
          return res.json(parsedResponse);
        } catch (geminiError: any) {
          console.error("[API] Gemini API error for flashcards:", geminiError);
        }
      }

      // Priority 2: Ollama (GPU mode)
      if (isGpuMode) {
        const ollamaUrl = process.env.OLLAMA_URL || "http://localhost:11434";
        const ollamaModel = process.env.OLLAMA_MODEL || "qwen2.5:32b";

        try {
          console.log(`[API] Using Ollama model for flashcards: ${ollamaModel}`);

          const hasArabic = /[\u0600-\u06FF]/.test(transcript);
          const language = hasArabic ? "Arabic" : "English";

          const ollamaResponse = await fetch(`${ollamaUrl}/api/generate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: ollamaModel,
              prompt: `You are an expert educational content creator. Create 8-15 high-quality study flashcards based on the following lecture transcript.

CRITICAL REQUIREMENTS:
- The transcript is in ${language}. You MUST write ALL terms and definitions in ${language}. Do NOT translate.
- Generate flashcards for key concepts, important terms, definitions, formulas, dates, names, or significant facts.
- Each flashcard should have a clear, concise term (front) and a definition (back).
- CRITICAL: The "definition" must be CONCISE and EASY TO MEMORIZE (10-20 words maximum). Focus on the core essence of the concept without unnecessary details. Keep it simple but accurate.
- Focus on the most important and memorable information that would help students master the material.
- CRITICAL: If the transcript contains mathematical formulas, laws, or equations, you MUST preserve them using standard LaTeX format (e.g., $inline$ or $$block$$) in both the term and definition.
- CRITICAL: DO NOT use markdown bolding (**text**) or italics. Write plain, clean text.
- CRITICAL: The "term" should be a clean keyword or concept name (e.g., "Agent"). DO NOT phrase the term as a question (e.g., strictly avoid "ما هو الـ Agent؟").
- Return ONLY valid JSON in this exact format (no markdown, no code blocks, no extra text):
{
  "flashcards": [
    {
      "id": 1,
      "term": "Term or concept name",
      "definition": "Concise definition (10-20 words max)"
    }
  ]
}

Transcript:
${transcript.substring(0, 20000)}

Generate the flashcards as JSON:`,
              stream: false,
              options: {
                temperature: 0.4,
                top_p: 0.9,
                top_k: 40,
                repeat_penalty: 1.1,
                num_predict: 3000,
                num_ctx: 8192,
              },
            }),
          });

          if (ollamaResponse.ok) {
            const ollamaData = await ollamaResponse.json();
            const aiResponse: string = (ollamaData.response || "").trim();

            if (aiResponse) {
              try {
                const cleanedResponse = aiResponse
                  .replace(/```json\n?/g, "")
                  .replace(/```\n?/g, "")
                  .trim();
                const parsedResponse = JSON.parse(cleanedResponse);

                if (parsedResponse.flashcards && Array.isArray(parsedResponse.flashcards) && parsedResponse.flashcards.length > 0) {
                  const validFlashcards = parsedResponse.flashcards
                    .filter((f: any) => f.term && f.definition && f.term.trim().length > 0 && f.definition.trim().length > 0)
                    .map((f: any, index: number) => ({
                      id: index + 1,
                      term: f.term.trim(),
                      definition: f.definition.trim(),
                    }));

                  if (validFlashcards.length > 0) {
                    console.log(`[API] Ollama flashcards generated with ${validFlashcards.length} cards`);
                    return res.json({ flashcards: validFlashcards });
                  }
                }
              } catch (parseError) {
                console.warn("[API] Failed to parse JSON from Ollama flashcards response");
              }
            }
          }
        } catch (ollamaError) {
          console.error("[API] Ollama flashcards generation error:", ollamaError);
        }
      }

      // Fallback: Simple flashcards generation
      console.log("[API] Using fallback flashcards generation");
      const sentences = transcript
        .split(/[.!?\n]+/)
        .map((s: string) => s.trim())
        .filter((s: string) => s.length > 30 && s.length < 200);

      const flashcards: any[] = [];
      const hasArabic = /[\u0600-\u06FF]/.test(transcript);

      if (sentences.length > 0) {
        // Extract key terms and create simple flashcards
        const keyTerms = sentences.slice(0, Math.min(10, sentences.length));
        keyTerms.forEach((sentence, index) => {
          const words = sentence.split(/\s+/);
          if (words.length > 3) {
            const term = words.slice(0, 3).join(" ");
            flashcards.push({
              id: index + 1,
              term: term,
              definition: sentence,
            });
          }
        });
      }

      if (flashcards.length === 0) {
        flashcards.push({
          id: 1,
          term: hasArabic ? "??????? ???????" : "Main Concept",
          definition: hasArabic ? "??????? ??????? ???? ??? ??????? ?? ??? ????????" : "The main concept discussed in this lecture",
        });
      }

      return res.json({ flashcards });
    } catch (error: any) {
      console.error("[API] Error generating flashcards:", error);
      res.status(500).json({ error: "Failed to generate flashcards" });
    }
  });

  /**
   * AI Formulas endpoint
   * POST /api/ai/formulas
   * Body: { "transcript": "...", "mode": "api" | "gpu" }
   */
  app.post("/api/ai/formulas", async (req: Request, res: Response) => {
    try {
      const { transcript, mode, geminiFileUri, geminiFileMimeType } = req.body as { transcript?: string; mode?: "gpu" | "api"; geminiFileUri?: string; geminiFileMimeType?: string; };

      const isGpuMode = mode === "gpu";

      if (!transcript || typeof transcript !== "string" || transcript.trim().length < 200) {
        return res.status(400).json({
          error: "Transcript is too short to generate formulas (minimum 200 characters)",
        });
      }

      console.log(`[API] Extracting formulas from transcript (${transcript.length} characters)`);

      const hasArabic = /[\u0600-\u06FF]/.test(transcript);
      const languageText = hasArabic ? "Arabic" : "English";

      // --- Server-side formula validator ---
      // Very permissive - accepts any mathematical expression
      const isRealMathFormula = (formula: string): boolean => {
        if (!formula || formula.length < 1) return false;
        // Must contain at least one real math operator or LaTeX math command
        const mathPatterns = [
          /[=+\-*/÷×]/, // basic arithmetic operators
          /\\frac/,       // fractions
          /\\sqrt/,       // square root
          /\\sum/,        // summation
          /\\int/,        // integral
          /\\prod/,       // product
          /\\lim/,        // limit
          /\\log/,        // logarithm
          /\\ln/,         // natural log
          /\\sin|\\cos|\\tan/, // trig functions
          /\\partial/,    // partial derivative
          /\\nabla/,      // gradient
          /\\Delta/,      // delta (change)
          /\^/,           // any exponentiation
          /_/,            // any subscript
          /\\cdot/,       // multiplication dot
          /\\times/,      // multiplication sign
          /\\div/,        // division sign
          /\\pm/,         // plus-minus
          /\\leq|\\geq|\\neq|\\approx|\\equiv|\\sim/, // comparison/equivalence
          /\\infty/,      // infinity
          /\\pi|\\phi|\\epsilon/, // constants
          /\\alpha|\\beta|\\gamma|\\theta|\\lambda|\\sigma|\\mu/, // Greek letters
          /\\vec|\\overrightarrow/, // vectors
          /\\iff|\\implies|\\land|\\lor|\\neg/, // logic
          /\\text\{/, // text in math (e.g. \text{distance})
          /[a-z0-9]\s*[=]\s*[a-z0-9]/i, // simple equations like "v = d/t" or "x = 5" or "F = ma"
          /[a-z0-9]\s*[<>]\s*[a-z0-9]/i, // inequalities like "x > 5"
          /\d+\s*[=+\-*/]\s*\d+/, // numeric equations like "5 + 3 = 8"
          /[a-z]\s*[=]\s*\d+/i, // variable equals number like "x = 5"
        ];
        return mathPatterns.some(pattern => pattern.test(formula));
      };

      const prompt = `## ROLE:
You are an expert mathematics and physics educator. Your goal is to extract EVERY SINGLE mathematical formula, law, equation, and relationship from the content - NO EXCEPTIONS.

## EXTRACTION STRATEGY (MAXIMUM COMPREHENSIVENESS):
- LAYER 1 (Direct): EVERY law/equation explicitly mentioned in the transcript.
- LAYER 2 (Contextual): If ANY concept is discussed that has a known formula, INCLUDE IT (e.g. "velocity" → v = d/t, "distance" → d = v×t, "area" → A = πr², "Normal Distribution" → PDF formula, "Pythagorean theorem" → a² + b² = c²).
- LAYER 3 (Visual): If you can see ANY mathematical expressions in the document/slides, extract them EXACTLY.
- LAYER 4 (Implicit): Even if not explicitly stated, if the topic is mathematical (physics, calculus, statistics, geometry), include ALL standard formulas for that topic.
- DO NOT skip formulas just because they seem "obvious" or "simple".
- Include formulas for: algebra, calculus, physics, statistics, geometry, trigonometry, probability, chemistry, economics, etc.
- If you see a graph, chart, or diagram with mathematical relationships, extract the underlying formulas.

## TEACHING STYLE (VERY IMPORTANT):
- "name": Use the common name (e.g. "Bayes' Theorem", "Pythagorean Theorem", "Newton's Second Law", "Distance Formula").
- "description": Explain it like a teacher! 
  - Start with the core idea (The "Intuition").
  - Explain WHEN and WHY we use it.
  - Add a simple real-world example if possible.
- "variables": Explain each symbol simply.

## CRITICAL LaTeX FORMATTING RULES:
The "formula" field MUST contain valid LaTeX with PROPER BACKSLASHES (\\\\).
- Use \\\\text{...} for words in formulas.
- Ensure all symbols like \\\\omega, \\\\sigma, \\\\pi, \\\\theta are correctly formatted.
- Use proper LaTeX for: fractions (\\\\frac), square roots (\\\\sqrt), integrals (\\\\int), summations (\\\\sum), etc.
- For superscripts use ^ and for subscripts use _ (e.g., x^2, a_1).
- For simple equations, you can use plain text with = sign (e.g., v = d/t).

## FORMAT:
Language: ${languageText}.
- ALL text fields ("name", "description", "variables", etc.) MUST be in ${languageText}.
- For Arabic, be encouraging and use clear academic language.
- Extract AS MANY formulas as possible - there is no limit. If the content is mathematical, extract 10, 20, or more formulas if they exist.

Return ONLY valid JSON (no markdown):
{
  "insight": { 
    "title": "Quick Study Tip in ${languageText}", 
    "description": "A encouraging conceptual summary in ${languageText}" 
  },
  "formulas": [
    {
      "id": 1,
      "name": "formula name",
      "formula": "LaTeX with backslashes or simple equation",
      "description": "THE TEACHER'S EXPLANATION: Intuition + Why it matters + Example",
      "category": "category (e.g., Physics, Calculus, Algebra, Statistics, Geometry)",
      "variables": [{ "symbol": "x", "meaning": "simple explanation" }]
    }
  ]
}

Transcript:
${transcript.substring(0, 25000)}`;

      // Priority 1: Ollama (GPU mode)
      const ollamaUrl = process.env.OLLAMA_URL || "http://localhost:11434";
      const ollamaModel = process.env.OLLAMA_MODEL || "qwen2.5:32b";

      if (isGpuMode) {
        try {
          console.log(`[API] Using Ollama model for formulas: ${ollamaModel}`);
          const ollamaResponse = await fetch(`${ollamaUrl}/api/generate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: ollamaModel,
              prompt: prompt + "\n\nReturn ONLY raw JSON.",
              stream: false,
              options: { temperature: 0.1, top_p: 0.9, num_predict: 3000, num_ctx: 16384 },
            }),
          });

          if (ollamaResponse.ok) {
            const ollamaData = await ollamaResponse.json();
            const aiResponse: string = (ollamaData.response || "").trim();
            const strictCleaned = cleanGeminiJson(aiResponse);
            const parsedResponse = JSON.parse(strictCleaned);
            return res.json(parsedResponse);
          }
        } catch (ollamaError) {
          console.error("[API] Ollama formulas extraction failed:", ollamaError);
          return res.status(500).json({ error: "Failed to extract formulas with GPU" });
        }
      }

      // Priority 2: Gemini API
      const geminiApiKey = process.env.GEMINI_API_KEY;
      if (geminiApiKey) {
        try {
          console.log("[API] Using Gemini API for formulas extraction");
          const genAI = new GoogleGenerativeAI(geminiApiKey!);

          let apiPrompt: string | any[] = prompt;
          if (geminiFileUri && geminiFileMimeType) {
            console.log(`[API] Using Vision API with file ${geminiFileUri} for formula extraction.`);
            apiPrompt = [
              prompt,
              {
                fileData: {
                  fileUri: geminiFileUri,
                  mimeType: geminiFileMimeType,
                },
              },
            ];
          }

          const aiResponse = await callGeminiWithRetry(genAI, apiPrompt, "gemini-2.5-flash", 3, 0.1, "application/json");

          if (aiResponse) {
            let parsedResponse: { formulas?: any[] } = { formulas: [] };
            try {
              const strictCleaned = cleanGeminiJson(aiResponse);
              parsedResponse = JSON.parse(strictCleaned);
            } catch (parseError) {
              console.warn("[API] Failed to parse JSON from Gemini formulas response, using Regex fallback");

              const formulasFallback: any[] = [];
              const cleanedText = aiResponse.replace(/```json\n?/gi, "").replace(/```\n?/g, "").trim();
              const formulaBlocks = cleanedText.split(/\{\s*"id"|\{\s*"name"/).slice(1);

              for (let i = 0; i < formulaBlocks.length; i++) {
                const block = formulaBlocks[i];
                const nameMatch = block.match(/"name"\s*:\s*"([^"]*)"/);
                const formulaMatch = block.match(/"formula"\s*:\s*"([^"]*)"/);
                const descMatch = block.match(/"description"\s*:\s*"([^"]*)"/);
                const catMatch = block.match(/"category"\s*:\s*"([^"]*)"/);

                if (nameMatch && formulaMatch) {
                  formulasFallback.push({
                    id: i + 1,
                    name: nameMatch[1],
                    formula: formulaMatch[1].replace(/\\\\/g, "\\"),
                    description: descMatch ? descMatch[1] : "",
                    category: (catMatch ? catMatch[1] : "Other")
                  });
                }
              }

              if (formulasFallback.length > 0) {
                parsedResponse = { formulas: formulasFallback };
              }
            }

            if (parsedResponse.formulas && Array.isArray(parsedResponse.formulas)) {
              // --- Server-side LaTeX sanitizer ---
              const sanitizeLatex = (tex: string): string => {
                if (!tex) return tex;
                let s = tex;

                // 1) Fix "vec" followed by letters
                s = s.replace(/(?<!\\)vec([A-Z][A-Za-z0-9]*)/g, '\\vec{$1}');
                
                // 2) Fix "overrightarrow"
                s = s.replace(/(?<!\\)overrightarrow/g, '\\overrightarrow');

                // 3) Fix "hat/bar/tilde/dot/overline/underline"
                s = s.replace(/(?<!\\)(hat|bar|tilde|dot|overline|underline)(?=[{A-Za-z])/g, '\\$1');

                // 4) Fix "text" labels (handling both Latin and Arabic)
                s = s.replace(/(?<!\\)text\{/g, '\\text{');
                s = s.replace(/(?<!\\)text([^\s{\\][^\s}]*)/g, '\\text{$1}');
                s = s.replace(/(?<!\\)textbf\{/g, '\\textbf{');
                s = s.replace(/(?<!\\)mathrm\{/g, '\\mathrm{');

                // 5) Fix "sqrt" and "frac"
                s = s.replace(/(?<!\\)sqrt(?=[{\[A-Za-z0-9])/g, '\\sqrt');
                s = s.replace(/(?<!\\)frac(?=[{])/g, '\\frac');

                // 6) Fix standalone math operator commands
                const standaloneOps = [
                  'equiv', 'iff', 'land', 'lor', 'neg', 'implies', 'therefore', 'because',
                  'forall', 'exists', 'nexists',
                  'sum', 'prod', 'int', 'iint', 'iiint', 'oint',
                  'lim', 'limsup', 'liminf', 'sup', 'inf', 'max', 'min',
                  'log', 'ln', 'exp', 'arg', 'deg', 'det', 'dim', 'gcd', 'hom', 'ker',
                  'sin', 'cos', 'tan', 'cot', 'sec', 'csc',
                  'arcsin', 'arccos', 'arctan',
                  'sinh', 'cosh', 'tanh',
                  'infty', 'partial', 'nabla',
                  'cdot', 'times', 'div', 'pm', 'mp',
                  'leq', 'geq', 'neq', 'approx', 'sim', 'simeq', 'cong', 'propto',
                  'subset', 'supset', 'subseteq', 'supseteq', 'cup', 'cap',
                  'in', 'notin', 'ni', 'emptyset', 'varnothing',
                  'rightarrow', 'leftarrow', 'Rightarrow', 'Leftarrow',
                  'leftrightarrow', 'Leftrightarrow', 'mapsto', 'to',
                  'uparrow', 'downarrow',
                  'perp', 'parallel', 'angle', 'triangle',
                  'star', 'circ', 'bullet',
                  'left', 'right',
                ];
                for (const cmd of standaloneOps) {
                  const re = new RegExp(`(?<!\\\\)\\b${cmd}\\b`, 'g');
                  s = s.replace(re, `\\${cmd}`);
                }

                // 7) Fix Greek letters
                const greekLetters = [
                  'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'varepsilon',
                  'zeta', 'eta', 'theta', 'vartheta', 'iota', 'kappa',
                  'lambda', 'mu', 'nu', 'xi', 'omicron', 'pi', 'varpi',
                  'rho', 'varrho', 'sigma', 'varsigma', 'tau', 'upsilon',
                  'phi', 'varphi', 'chi', 'psi', 'omega',
                  'Gamma', 'Delta', 'Theta', 'Lambda', 'Xi', 'Pi',
                  'Sigma', 'Upsilon', 'Phi', 'Psi', 'Omega',
                ];
                for (const letter of greekLetters) {
                  const re = new RegExp(`(?<!\\\\)\\b${letter}\\b`, 'g');
                  s = s.replace(re, `\\${letter}`);
                }

                // 8) Clean up double backslashes (but be careful not to break already-correct ones)
                s = s.replace(/\\\\(?=[a-zA-Z])/g, '\\');

                // 9) Fix common English words that might be in math mode causing red text
                const englishWords = ['If', 'if', 'then', 'Then', 'else', 'Else', 'classify', 'Classify', 'to', 'for', 'For', 'when', 'When', 'where', 'Where', 'and', 'And', 'or', 'Or', 'given', 'Given'];
                for (const word of englishWords) {
                  const re = new RegExp(`(?<!\\\\|\\{)\\b${word}\\b(?!\\})`, 'g');
                  s = s.replace(re, `\\text{${word}}`);
                }

                // 10) Fix simple equations like "v = d/t" to be proper LaTeX
                s = s.replace(/([a-z])\s*=\s*([a-z0-9\/]+)/gi, '$1 = $2');

                return s;
              };

              // Step 1: Sanitize LaTeX FIRST (fix missing backslashes)
              const sanitizedFormulas = parsedResponse.formulas.map((f: any) => ({
                ...f,
                formula: sanitizeLatex(f.formula || ""),
                variables: Array.isArray(f.variables) 
                  ? f.variables.map((v: any) => ({ ...v, symbol: sanitizeLatex(v.symbol || "") }))
                  : f.variables,
              }));

              // Step 2: THEN filter — now backslashes are fixed so validator works correctly
              const validFormulas = sanitizedFormulas.filter((f: any) => {
                const formulaStr = f.formula || "";
                const isValid = isRealMathFormula(formulaStr);
                if (!isValid) {
                  console.log(`[API] Rejecting non-math formula: "${f.name}" -> "${formulaStr}"`);
                }
                return isValid;
              });

              console.log(`[API] Gemini formulas: ${parsedResponse.formulas.length} raw -> sanitized -> ${validFormulas.length} valid`);
              return res.json({ formulas: validFormulas });
            }
          }
        } catch (geminiError: any) {
          console.error("[API] Gemini API error for formulas:", geminiError);
        }
      }

      // Priority 2: Ollama (GPU mode)
      if (isGpuMode) {
        const ollamaUrl = process.env.OLLAMA_URL || "http://localhost:11434";
        const ollamaModel = process.env.OLLAMA_MODEL || "qwen2.5:32b";

        try {
          console.log(`[API] Using Ollama model for formulas: ${ollamaModel}`);
          const ollamaResponse = await fetch(`${ollamaUrl}/api/generate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: ollamaModel,
              prompt: prompt,
              stream: false,
              options: { temperature: 0.1, top_p: 0.9, top_k: 40 },
            }),
          });

          if (ollamaResponse.ok) {
            const ollamaData = await ollamaResponse.json();
            const aiResponse: string = (ollamaData.response || "").trim();

            if (aiResponse) {
              try {
                // Extract JSON part
                const jsonMatch = aiResponse.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
                const cleanedResponse = jsonMatch ? jsonMatch[0] : aiResponse;
                
                // Final sanitize for Ollama output which is often messy
                const strictCleaned = cleanGeminiJson(cleanedResponse);
                const parsedResponse = JSON.parse(strictCleaned);

                if (parsedResponse.formulas && Array.isArray(parsedResponse.formulas)) {
                  console.log(`[API] Ollama formulas generated with ${parsedResponse.formulas.length} formulas`);
                  return res.json({ formulas: parsedResponse.formulas });
                }
              } catch (parseError) {
                console.warn("[API] Failed to parse JSON from Ollama formulas response. Raw output:", aiResponse);
              }
            }
          }
        } catch (ollamaError) {
          console.error("[API] Ollama formulas extraction error:", ollamaError);
        }
      }

      // Fallback: Return empty formulas array (graceful degradation)
      console.log("[API] No formulas could be extracted or generated");
      return res.json({ formulas: [] });
    } catch (error: any) {
      console.error("[API] Error generating formulas:", error);
      res.status(500).json({ error: "Failed to generate formulas" });
    }
  });

  /**
   * Text summarization endpoint using Gemini API
   * POST /api/summarize
   */
  app.post("/api/summarize", async (req: Request, res: Response) => {
    try {
      const { text } = req.body;

      if (!text || typeof text !== "string" || text.trim().length === 0) {
        return res.status(400).json({ error: "Text is required" });
      }

      const geminiApiKey = process.env.GEMINI_API_KEY;
      if (!geminiApiKey) {
        return res.status(500).json({ error: "Gemini API key is not configured" });
      }

      const genAI = new GoogleGenerativeAI(geminiApiKey);
      const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

      const prompt = `You are a high-level academic content summarizer. Analyze the provided text and structure your response exactly as follows:

1. **Introduction**: A brief overview of the main topic and its significance (2-3 sentences).
2. **Summary**: A comprehensive but concise summary of the core concepts and arguments.
3. **Key Points**: A bulleted list of the most important takeaways and specific details.

CRITICAL RULES:
- Detect the language of the input text and respond in the SAME language.
- If the content is mathematical or scientific, ensure formulas and numerical data are preserved.
- Return the response as valid JSON with these keys: "introduction", "summary", "keypoints" (as an array of strings).

Text to summarize:
${text.substring(0, 30000)}`;

      const summarizePrompt = `Summarize this text in 3 sections: introduction, summary, keypoints.
Return ONLY valid JSON: { "introduction": "...", "summary": "...", "keypoints": ["...", "..."] }.
CRITICAL: Wrap EVERY mathematical formula, symbol, or variable in $...$ (e.g., $\lambda$, $x^2$).
Language: Match input.
Text: ${text.substring(0, 25000)}`;

      const aiResponse = await callGeminiWithRetry(genAI, summarizePrompt, "gemini-2.5-flash");

      let parsedResponse;
      try {
        const strictCleaned = cleanGeminiJson(aiResponse);
        parsedResponse = JSON.parse(strictCleaned);
      } catch (e) {
        console.warn("[API] Failed to parse /api/summarize JSON, using regex fallback");
        const cleanedResponse = aiResponse.replace(/```json\n?/gi, "").replace(/```\n?/g, "").trim();

        const extractField = (fieldName: string) => {
          const match = cleanedResponse.match(new RegExp(`"${fieldName}"\\s*:\\s*(?:\\[(.*?)\\]|"([^"]*)")`, "is"));
          if (match) {
            if (match[1] !== undefined) {
              const arrMatch = match[1].match(/"([^"]*)"/g);
              return arrMatch ? arrMatch.map((s: string) => s.replace(/^"|"$/g, "").replace(/\\n/g, "\n")) : [];
            }
            return match[2] !== undefined ? match[2].replace(/\\n/g, "\n") : null;
          }
          return null;
        };

        const intro = extractField("introduction");
        const summ = extractField("summary");
        const kp = extractField("keypoints");

        if (!intro && !summ && (!kp || kp.length === 0)) {
          parsedResponse = { introduction: "", summary: cleanedResponse, keypoints: [] };
        } else {
          parsedResponse = {
            introduction: typeof intro === "string" ? intro : "",
            summary: typeof summ === "string" ? summ : "",
            keypoints: Array.isArray(kp) ? kp : []
          };
        }
      }

      return res.json({
        introduction: parsedResponse.introduction,
        summary: parsedResponse.summary,
        keypoints: parsedResponse.keypoints
      });
    } catch (error: any) {
      console.error("[API] Error in /api/summarize:", error);
      res.status(500).json({ error: "Failed to generate summary" });
    }
  });

  /**
   * AI Slides generation endpoint
   * POST /api/ai/slides
   * Body: { transcript, summary?, theme? }
   * Returns: { lectureTitle, language, theme, slides: [{ title, bullets, notes? }] }
   */
  app.post("/api/ai/slides", async (req: Request, res: Response) => {
    try {
      const { transcript, summary, theme = "clean", mode } = req.body as {
        transcript?: string;
        summary?: string | string[];
        theme?: "clean" | "dark" | "academic" | "vibrant";
        mode?: "gpu" | "api";
      };

      if (!transcript || typeof transcript !== "string") {
        return res.status(400).json({ error: "Transcript is required" });
      }

      const isGpuMode = mode === "gpu";
      const hasArabic = /[\u0600-\u06FF]/.test(transcript);
      const language = hasArabic ? "Arabic" : "English";

      // Priority 1: Ollama (GPU) if requested or Gemini not available
      const ollamaUrl = process.env.OLLAMA_URL || "http://localhost:11434";
      const ollamaModel = process.env.OLLAMA_MODEL || "qwen2.5:14b";

      if (isGpuMode || !process.env.GEMINI_API_KEY) {
        try {
          const ollamaCheck = await fetch(`${ollamaUrl}/api/tags`, {
            method: "GET",
            signal: AbortSignal.timeout(2000),
          });

          if (ollamaCheck.ok) {
            console.log(`[API] Using Ollama model: ${ollamaModel} for slides generation`);

            const slidesPrompt = language === "Arabic"
              ? `??? ???? ????. ???? ????? JSON ?? ????????.

??? ????: JSON ???. ???? markdown? ???? ???.

???????:
{ "lectureTitle": "?????", "slides": [{ "title": "????? 1", "bullets": ["???? 1", "???? 2"], "visualKeyword": "search term in English" }] }

?????????:
- 8-10 ?????
- ?? ?????: ????? + 3-5 ????
- ??? visualKeyword: ???? ??? ???????? ????? ??????? (????: "Artificial Intelligence", "DNA")
- ???? ??? ??????? ????????
- JSON ???? ?????

????????:
${transcript.substring(0, 25000)}

???? JSON:`
              : `You are an expert presentation designer. Create a professional slide deck.

Required JSON Format:
{
  "lectureTitle": "Title",
  "slides": [
    {
      "title": "Slide Title",
      "bullets": ["Point 1", "Point 2"],
      "visualKeyword": "Specific English search term for an image representing this slide",
      "notes": "Notes"
    }
  ]
}

Quality Guidelines:
1. Number of slides: 10 slides.
2. Each slide must have a unique, specific "visualKeyword" (e.g., "stethoscpoe", "server rack").
3. Coverage: Comprehensive coverage of the lecture.

Lecture Transcript:
${transcript.substring(0, 30000)}`;

            const ollamaResponse = await fetch(`${ollamaUrl}/api/generate`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                model: ollamaModel,
                prompt: slidesPrompt,
                stream: false,
                options: {
                  temperature: 0.2,
                  top_k: 50,
                  top_p: 0.95,
                  repeat_penalty: 1.15,
                  num_predict: 4500,  // More tokens for complete slides
                  num_ctx: 16384,
                },
              }),
            });

            if (ollamaResponse.ok) {
              const ollamaData = await ollamaResponse.json();
              const aiResponseRaw = (ollamaData.response || "").trim();

              console.log("[API] Ollama slides response length:", aiResponseRaw.length);

              // Clean and parse JSON
              let cleanedResponse = aiResponseRaw
                .replace(/```json\n?/gi, "")
                .replace(/```/g, "")
                .trim();

              const jsonMatch = cleanedResponse.match(/\{[\s\S]*\}/);
              if (jsonMatch) {
                cleanedResponse = jsonMatch[0];
              }

              try {
                const parsedResponse = JSON.parse(cleanedResponse);

                if (parsedResponse.slides && Array.isArray(parsedResponse.slides) && parsedResponse.slides.length > 0) {
                  // Format slides and fetch images in parallel
                  const formattedSlides = await Promise.all(parsedResponse.slides.map(async (slide: any, index: number) => {
                    const title = slide.title || (language === "Arabic" ? `????? ${index + 1}` : `Slide ${index + 1}`);
                    const keyword = slide.imageKeyword || slide.visualKeyword || title;
                    
                    // Fetch image from Pexels API
                    let finalUrl = null;
                    try {
                      const res = await fetch(`https://api.pexels.com/v1/search?query=${encodeURIComponent(keyword)}&per_page=1&orientation=landscape`, {
                        headers: { Authorization: process.env.PEXELS_API_KEY || "NzhhF45UoWw3m4FpPInO5XhPzQZ6N9dAY77a56v7FMB2974R34aXwIih" }
                      });
                      if (res.ok) {
                        const data = await res.json() as any;
                        if (data.photos && data.photos.length > 0) {
                          finalUrl = data.photos[0].src.large2x || data.photos[0].src.large;
                        }
                      }
                    } catch (e) {
                      console.warn("Pexels failed for fallback", e);
                    }
                    const imageResult = finalUrl ? { base64: null, type: 'url', url: finalUrl } : null;

                    return {
                      id: index + 1,
                      title: title,
                      content: Array.isArray(slide.bullets) ? slide.bullets : (slide.bullets ? [slide.bullets] : []),
                      notes: slide.notes || "",
                      imageUrl: imageResult ? imageResult.url : null
                    };
                  }));

                  console.log(`[API] Ollama slides generated: ${formattedSlides.length} slides`);

                  return res.json({
                    lectureTitle: parsedResponse.lectureTitle || (language === "Arabic" ? "????? ????????" : "Lecture Slides"),
                    language,
                    theme,
                    slides: formattedSlides,
                  });
                }
              } catch (parseError: any) {
                console.warn("[API] Failed to parse Ollama slides JSON:", parseError.message);
                // In GPU mode, don't fall back to Gemini - return error
                if (isGpuMode) {
                  return res.status(500).json({
                    error: "Failed to generate slides with Ollama (JSON parsing error)",
                    details: "Please try again or use API mode",
                  });
                }
                // Fall through to Gemini only if not in GPU mode
              }
            }
          }
        } catch (ollamaError: any) {
          console.error("[API] Ollama slides generation failed:", ollamaError.message);
          // In GPU mode, return error instead of falling back
          if (isGpuMode) {
            return res.status(500).json({
              error: "Ollama is not available for slides generation",
              details: "Please ensure Ollama is running or use API mode",
            });
          }
          // Fall through to Gemini only if not in GPU mode
        }
      }

      // Priority 2: Gemini API (only if not GPU mode)
      if (isGpuMode) {
        // Should not reach here, but just in case
        return res.status(500).json({
          error: "GPU mode slides generation failed",
          details: "Please check Ollama or use API mode",
        });
      }

      const geminiApiKey = process.env.GEMINI_API_KEY;
      if (!geminiApiKey) {
        return res.status(500).json({ error: "Gemini API key not configured" });
      }

      const genAI = new GoogleGenerativeAI(geminiApiKey);

      // Use gemini-2.5-flash (most reliable and widely available)
      const model = genAI.getGenerativeModel({
        model: "gemini-2.5-flash",
        generationConfig: {
          temperature: 0.3,
          topP: 0.9,
          maxOutputTokens: 4096,
        },
      });

      console.log(`[API] Using Gemini model: gemini-2.5-flash for ${language} language`);

      // ── SLIDES_PROMPT (spec: 7 slide types, auto language detection) ─────────
      const SLIDES_SYSTEM_PROMPT = `You are a professional presentation designer.
Analyze the provided content and return ONLY a valid JSON array.
No markdown, no backticks, no explanation, no text before or after the JSON.

==== LANGUAGE RULES ====
- Detect language automatically from the content
- Arabic content  → all text in proper formal Arabic (فصحى), direction: rtl
- English content → professional English, direction: ltr
- NEVER mix languages on the same slide

==== SLIDE COUNT ====
- Minimum: 6 slides
- Maximum: 18 slides
- Count based on content depth
- Each slide covers ONE focused concept only

==== TEXT RULES ====
- title:    max 8 words (Arabic) / max 10 words (English)
- bullets:  exactly 4 to 8 per slide (ensure they are deep and informative)
- Each bullet: max 20 words (Arabic) / max 25 words (English)
- subtitle (intro only): max 15 words
- speaker_notes: full explanation, same language, max 60 words
- NO symbols, NO emojis, NO asterisks, NO markdown, NO dashes as bullets
- Every bullet should be a complete, well-formed sentence or thought

==== SLIDE TYPES ====
Use a variety across the presentation:

"intro"      → First slide only. Fields: title, subtitle
"section"    → Topic divider. Fields: title only
"content"    → Standard. Fields: title, bullets (4–8)
"quote"      → One impactful sentence. Fields: title, quote
"stats"      → Numbers slide. Fields: title, stats[] {value, label} — exactly 3
"comparison" → Two sides. Fields: title, left_label, right_label, left_points[], right_points[]
"summary"    → Last slide only. Fields: title, bullets (4–8 takeaways)

==== STRICT JSON FORMAT ====
Return ONLY the JSON array. Start with [ and end with ]. Nothing else.`;

      const prompt = `${SLIDES_SYSTEM_PROMPT}

Lecture content to convert into slides:
${transcript.substring(0, 30000)}`;

      const aiResponseRaw = await callGeminiWithRetry(genAI, prompt, "gemini-2.5-flash");

      console.log("[API] Raw AI response length:", aiResponseRaw.length);
      console.log("[API] Raw AI response preview:", aiResponseRaw.substring(0, 200));

      const cleanedResponse = aiResponseRaw.replace(/```json\n?/gi, "").replace(/```\n?/g, "").trim();

      // New format: a raw JSON array of typed slide objects
      let rawSlides: any[] = [];
      try {
        const strictCleaned = cleanGeminiJson(aiResponseRaw);
        const parsed = JSON.parse(strictCleaned);
        // Accept both array directly (new spec) and legacy { slides: [...] } object
        rawSlides = Array.isArray(parsed) ? parsed : (parsed.slides || []);
      } catch (parseError: any) {
        console.warn("[API] Failed to parse slides JSON:", parseError);
        // Fallback: try to extract array with regex
        const arrayMatch = cleanedResponse.match(/\[[\s\S]*\]/);
        if (arrayMatch) {
          try { rawSlides = JSON.parse(arrayMatch[0]); } catch {}
        }
        if (!rawSlides.length) {
          return res.status(500).json({ error: "Invalid slides format from AI", rawResponse: cleanedResponse.substring(0, 500) });
        }
      }

      if (!Array.isArray(rawSlides) || rawSlides.length === 0) {
        return res.status(500).json({ error: "No slides returned by AI" });
      }

      // Normalize all 7 slide types to a unified frontend shape
      const VALID_TYPES = ["intro", "section", "content", "quote", "stats", "comparison", "summary"];
      const validatedSlides = rawSlides
        .filter((s: any) => s && s.title)
        .map((s: any, idx: number) => {
          const slideType = VALID_TYPES.includes(s.type) ? s.type : "content";
          const bullets: string[] = Array.isArray(s.bullets)
            ? s.bullets.filter((b: any) => b && String(b).trim().length > 0)
            : [];
          return {
            type:         slideType,
            slide_number: s.slide_number || idx + 1,
            title:        String(s.title || "").trim(),
            subtitle:     s.subtitle   ? String(s.subtitle).trim()   : undefined,
            quote:        s.quote      ? String(s.quote).trim()      : undefined,
            stats:        Array.isArray(s.stats)      ? s.stats      : undefined,
            left_label:   s.left_label  ? String(s.left_label).trim()  : undefined,
            right_label:  s.right_label ? String(s.right_label).trim() : undefined,
            left_points:  Array.isArray(s.left_points)  ? s.left_points  : undefined,
            right_points: Array.isArray(s.right_points) ? s.right_points : undefined,
            bullets,
            speaker_notes: s.speaker_notes ? String(s.speaker_notes).trim() : "",
            direction:    s.direction || (hasArabic ? "rtl" : "ltr"),
            language:     s.language  || (hasArabic ? "ar" : "en"),
          };
        });

      console.log(`[API] Generated ${validatedSlides.length} slides (new spec format)`);

      // Detect title from intro slide
      const introSlide = validatedSlides.find(s => s.type === "intro");
      const lectureTitle = introSlide?.title || (hasArabic ? "شرائح المحاضرة" : "Lecture Slides");

      return res.json({
        lectureTitle,
        language,
        theme,
        slides: validatedSlides,
      });
    } catch (error: any) {
      console.error("[API] Error generating slides:", error);
      console.error("[API] Error details:", {
        message: error.message,
        name: error.name,
        stack: error.stack?.substring(0, 500),
      });

      // Check if it's a network/API error
      if (error.message?.includes("fetch failed") || error.message?.includes("network")) {
        return res.status(503).json({
          error: "Network error connecting to AI service",
          details: "Please check your internet connection and API key",
        });
      }

      return res.status(500).json({
        error: "Failed to generate slides",
        details: error.message || "Unknown error occurred",
      });
    }
  });

  /**
   * Nano Banana - Generate Image for a Single Slide
   * POST /api/nano-banana/generate
   */
  app.post("/api/nano-banana/generate", async (req: Request, res: Response) => {
    try {
      const slideData = req.body;
      const pythonPath = process.env.PYTHON_CMD || "python";
      const scriptPath = path.join(__dirname, "scripts", "nano_banana_cli.py");
      
      const child = spawn(pythonPath, [scriptPath, JSON.stringify(slideData)]);
      let stdoutData = "";
      let stderrData = "";
      
      child.stdout.on("data", (data) => { stdoutData += data; });
      child.stderr.on("data", (data) => { stderrData += data; });
      
      child.on("close", (code) => {
        if (code !== 0) {
          console.error("[Nano Banana API] Error:", stderrData);
          return res.status(500).json({ error: "Failed to generate image", details: stderrData });
        }
        try {
          res.json(JSON.parse(stdoutData));
        } catch (e: any) {
          res.status(500).json({ error: "Invalid JSON from python", details: e.message });
        }
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  /**
   * Nano Banana - Generate Images for Multiple Slides
   * POST /api/nano-banana/generate-batch
   */
  app.post("/api/nano-banana/generate-batch", async (req: Request, res: Response) => {
    try {
      const slides = req.body.slides || req.body;
      if (!slides || !Array.isArray(slides)) {
        return res.status(400).json({ error: "slides array is required" });
      }
      
      const pythonPath = process.env.PYTHON_CMD || "python";
      const scriptPath = path.join(__dirname, "scripts", "nano_banana_cli.py");
      
      const child = spawn(pythonPath, [scriptPath, "-"]);
      let stdoutData = "";
      let stderrData = "";
      
      child.stdout.on("data", (data) => { stdoutData += data; });
      child.stderr.on("data", (data) => { stderrData += data; });
      
      child.on("close", (code) => {
        if (code !== 0) {
          console.error("[Nano Banana API] Batch Error:", stderrData);
          return res.status(500).json({ error: "Failed to generate batch images", details: stderrData });
        }
        try {
          res.json(JSON.parse(stdoutData));
        } catch (e: any) {
          res.status(500).json({ error: "Invalid JSON from python", details: e.message });
        }
      });
      child.stdin.write(JSON.stringify(slides));
      child.stdin.end();
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  /**
   * Download slides as PowerPoint (.pptx)
   * POST /api/ai/slides/download
   * Body: { transcript, summary?, theme?, lectureTitle? }
   * Returns: PPTX file download
   */
  app.post("/api/ai/slides/download", async (req: Request, res: Response) => {
    try {
      const { slides: providedSlides, theme = "clean", lectureTitle = "Lecture Slides", customColor, nanobanana, visualStyle, layoutStyle, nbBgColor, nbPanelColor, nbTitleColor } = req.body as {
        slides?: { title: string; content: string[] }[];
        theme?: string;
        lectureTitle?: string;
        customColor?: string;
        nanobanana?: boolean;
        visualStyle?: string;
        layoutStyle?: string;
        nbBgColor?: string;
        nbPanelColor?: string;
        nbTitleColor?: string;
      };

      // Use provided slides if available, otherwise return error
      if (!providedSlides || !Array.isArray(providedSlides) || providedSlides.length === 0) {
        return res.status(400).json({ error: "Slides are required" });
      }

      // Detect language from first slide
      const firstSlideText = providedSlides[0]?.title || "";
      const hasArabic = /[\u0600-\u06FF]/.test(firstSlideText);
      const language = hasArabic ? "Arabic" : "English";

      const normalizeBullets = (content?: string[]) => {
        if (!Array.isArray(content)) return [];

        // Clean unusual Unicode characters (private use area, control chars, etc.)
        const cleanUnicode = (text: string): string => {
          return text
            // Remove private use area characters (U+E000 to U+F8FF, U+F0000 to U+FFFFD, U+100000 to U+10FFFD)
            .replace(/[\uE000-\uF8FF]/g, "")
            // Remove other unusual symbols that appear in transcripts
            .replace(/[\uFFF0-\uFFFF]/g, "")
            // Replace common bullet symbols with standard bullet
            .replace(/[\u2022\u2023\u25E6\u2043\u2219\u25C6\u25D8\u25D9\u25AA\u25AB\u2013\u2014]/g, "•")
            // Remove control characters except newlines
            .replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, "")
            // Clean up multiple spaces
            .replace(/\s+/g, " ");
        };

        const raw = content
          .flatMap((line) => String(line || "").split(/\n|•|·|▪|◦|;/g))
          .map((line) => cleanUnicode(line).replace(/^\s*[\-\*\d\.\)\(•]+\s*/, "").trim())
          .filter(Boolean);

        // Keep concise, presentation-friendly bullets.
        const compact = raw.map((line) => line.length > 180 ? `${line.slice(0, 177)}...` : line);
        return compact.slice(0, 6);
      };

      // Smart visual keyword extraction using categorization and context awareness
      const extractVisualKeyword = (title: string, bullets: string[]) => {
        const fullText = `${title} ${bullets.join(" ")}`.toLowerCase();

        // Domain detection for better keyword matching
        const domains = {
          technology: /\b(?:computer|software|hardware|ai|artificial intelligence|machine learning|code|programming|developer|algorithm|data|cloud|server|database|network|cybersecurity|blockchain|robotics|automation|digital|tech)\b/i,
          science: /\b(?:physics|chemistry|biology|molecule|atom|dna|cell|organism|evolution|energy|matter|universe|galaxy|planet|experiment|laboratory|research|scientific)\b/i,
          medicine: /\b(?:medical|health|doctor|patient|hospital|treatment|disease|medicine|drug|therapy|surgery|diagnosis|symptom|anatomy|physiology)\b/i,
          business: /\b(?:business|company|corporate|management|marketing|finance|investment|economy|market|strategy|leadership|entrepreneur|startup|revenue|profit)\b/i,
          nature: /\b(?:nature|environment|climate|ecosystem|forest|ocean|mountain|wildlife|conservation|sustainable|green|organic|earth|weather|pollution)\b/i,
          education: /\b(?:education|learning|student|teacher|school|university|academic|knowledge|study|course|curriculum|degree|scholarship)\b/i,
          arts: /\b(?:art|design|creative|painting|music|theater|film|photography|architecture|fashion|culture|heritage|literature|poetry)\b/i,
          engineering: /\b(?:engineering|mechanical|civil|electrical|construction|infrastructure|manufacturing|industrial|automation|machinery)\b/i,
          mathematics: /\b(?:mathematics|math|algebra|calculus|geometry|statistics|equation|formula|theorem|calculation|number|graph)\b/i,
        };

        // Detect primary domain
        let detectedDomain = "education";
        for (const [domain, pattern] of Object.entries(domains)) {
          if (pattern.test(fullText)) {
            detectedDomain = domain;
            break;
          }
        }

        // Extract key concepts (2-3 word phrases are better for image search)
        const conceptPatterns = [
          // Tech patterns
          { pattern: /\b(?:artificial intelligence|machine learning|deep learning|neural network|data science|cloud computing|cyber security|block chain)\b/gi, weight: 3 },
          // Science patterns
          { pattern: /\b(?:solar system|climate change|renewable energy|global warming|quantum physics|molecular biology)\b/gi, weight: 3 },
          // Business patterns
          { pattern: /\b(?:digital marketing|supply chain|project management|human resources|financial analysis)\b/gi, weight: 3 },
          // General important terms
          { pattern: /\b(?:innovation|creativity|collaboration|leadership|strategy|analysis|development|growth|success|future)\b/gi, weight: 2 },
        ];

        const candidates: Map<string, number> = new Map();

        // Extract multi-word concepts with weights
        for (const { pattern, weight } of conceptPatterns) {
          const matches = fullText.match(pattern) || [];
          for (const match of matches) {
            const key = match.toLowerCase().trim();
            candidates.set(key, (candidates.get(key) || 0) + weight);
          }
        }

        // Extract important single words (nouns/keywords)
        const words = fullText
          .replace(/[^\p{L}\p{N}\s]/gu, " ")
          .split(/\s+/)
          .filter(w => w.length >= 4 && w.length <= 15);

        const stopWords = new Set([
          "this","that","with","from","they","them","their","have","been","were","will","would","could","should",
          "about","into","through","during","before","after","above","below","between","under","again","further",
          "then","than","once","here","there","when","where","what","which","while","because","until","although",
          "however","therefore","moreover","furthermore","nevertheless","meanwhile","otherwise","instead","additionally",
          "consequently","accordingly","subsequently","specifically","particularly","especially","essentially","basically",
          "actually","certainly","definitely","probably","possibly","perhaps","maybe","usually","always","never",
          "often","sometimes","frequently","rarely","recently","currently","finally","initially","previously",
          "following","various","several","certain","different","similar","important","necessary","available",
          "possible","impossible","difficult","easy","simple","complex","clear","obvious","significant","major",
          "minor","primary","secondary","main","key","central","basic","general","specific","particular",
          "certain","such","these","those","some","many","much","more","most","other","another","same","own",
          "very","quite","rather","pretty","really","truly","highly","greatly","deeply","strongly","clearly",
          "obviously","definitely","absolutely","completely","totally","entirely","fully","partly","mostly",
          "almost","nearly","approximately","exactly","precisely","roughly","likely","surely","certainly"
        ]);

        for (const word of words) {
          if (stopWords.has(word)) continue;
          // Prefer concrete nouns over abstract
          const isConcrete = /(?:system|network|structure|process|method|technique|tool|device|machine|engine|platform|application|framework|model|theory|concept|principle|law|rule|standard|protocol|interface|component|module|function|service|product|project|team|organization|institution|building|vehicle|equipment|material|resource|element|factor|aspect|feature|benefit|advantage|challenge|problem|solution|result|outcome|effect|impact|role|purpose|goal|objective|target|step|stage|phase|level|type|kind|category|class|group|section|part|piece|area|region|zone|field|domain|sector|industry|market|customer|user|client|patient|student|teacher|doctor|engineer|manager|leader|worker|employee|member|participant|expert|specialist|professional|researcher|scientist|analyst|developer|designer|creator|artist|author|writer|speaker|presenter)/.test(word);
          candidates.set(word, (candidates.get(word) || 0) + (isConcrete ? 2 : 1));
        }

        // Sort by weight and get top candidates
        const sorted = [...candidates.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([word]) => word);

        // Build keyword phrase (prefer 2-3 word phrases over single words)
        let keyword = sorted.slice(0, 2).join(" ").trim();

        // Fallback domain-specific keywords
        if (!keyword || keyword.length < 4) {
          const fallbacks: Record<string, string> = {
            technology: "technology innovation digital",
            science: "scientific research laboratory",
            medicine: "medical healthcare hospital",
            business: "business corporate office",
            nature: "nature environment landscape",
            education: "education learning classroom",
            arts: "art creative design",
            engineering: "engineering construction industrial",
            mathematics: "mathematics calculation formula",
          };
          keyword = fallbacks[detectedDomain] || title || "educational concept";
        }

        return { keyword, domain: detectedDomain };
      };

      // Clean unusual Unicode characters from title
      const cleanTitle = (text: string): string => {
        return text
          .replace(/[\uE000-\uF8FF]/g, "") // Private use area
          .replace(/[\uFFF0-\uFFFF]/g, "") // Special symbols
          .replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, "") // Control chars
          .replace(/\s+/g, " ")
          .trim();
      };

      // ── Normalize incoming slides ─────────────────────────────────────────
      // Supports both old {title, content[]} and new spec typed objects
      const normalizeText = (t: any) => String(t || "")
        .replace(/[\uE000-\uF8FF\uFFF0-\uFFFF]/g, "")
        .replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, "")
        .replace(/\s+/g, " ").trim();

      const slides: any[] = (providedSlides as any[]).map((s: any) => ({
        type:        s.type || "content",
        title:       normalizeText(s.title),
        subtitle:    normalizeText(s.subtitle),
        quote:       normalizeText(s.quote),
        left_label:  normalizeText(s.left_label),
        right_label: normalizeText(s.right_label),
        left_points:  Array.isArray(s.left_points)  ? s.left_points.map(normalizeText)  : [],
        right_points: Array.isArray(s.right_points) ? s.right_points.map(normalizeText) : [],
        stats:        Array.isArray(s.stats)        ? s.stats        : [],
        bullets:      normalizeBullets(s.content || s.bullets),
        direction:   s.direction || (hasArabic ? "rtl" : "ltr"),
        imageUrl:    "",
      }));

      // ── Call Nano Banana if enabled ───────────────────────────────────────
      let slideImages: Record<string, string> = {};
      if (nanobanana) {
        console.log("[Nano Banana] Starting image generation...");
        try {
          const slidesForNano = slides.map((s, idx) => ({ ...s, id: idx, slide_number: idx, language: hasArabic ? "ar" : "en" }));
          const pythonPath = process.env.PYTHON_CMD || "python";
          const scriptPath = path.join(__dirname, "scripts", "nano_banana_cli.py");
          const inputJson = JSON.stringify(slidesForNano);

          slideImages = await new Promise((resolve) => {
            const child = spawn(pythonPath, [scriptPath, "-"]);
            let stdoutData = "";
            let stderrData = "";

            child.stdout.on("data", (data) => { stdoutData += data; });
            child.stderr.on("data", (data) => { stderrData += data; });

            child.on("close", (code) => {
              if (code !== 0) {
                console.error("[Nano Banana] Error:", stderrData);
                resolve({});
                return;
              }
              try {
                const result = JSON.parse(stdoutData);
                resolve(result.images || {});
              } catch (e) {
                console.error("[Nano Banana] JSON parse error:", e);
                resolve({});
              }
            });

            child.stdin.write(inputJson);
            child.stdin.end();
          });
          console.log("[Nano Banana] Generated images:", slideImages);
        } catch (e) {
          console.error("[Nano Banana] Failed:", e);
        }
      }

      // ── Create PowerPoint ─────────────────────────────────────────────────
      const pptx = new pptxgen();
      if (!pptx) throw new Error("Failed to initialize PowerPoint generator");

      // ── 8 highly diverse spec themes ─────────────────────────────────────────
      const SPEC_THEMES: Record<string, any> = {
        modern_dark:       { bg: "050505", title: "FFFFFF", text: "F1F5F9", accent: "E94560", sep: "E94560", font: "Arial" },
        clean_light:       { bg: "FFFFFF", title: "0F172A", text: "334155", accent: "2563EB", sep: "2563EB", font: "Arial" },
        academic_blue:     { bg: "0A192F", title: "64FFDA", text: "FFFFFF", accent: "64FFDA", sep: "64FFDA", font: "Arial" },
        midnight_gold:     { bg: "1C1917", title: "D4AF37", text: "FFFFFF", accent: "D4AF37", sep: "D4AF37", font: "Arial" },
        vibrant_sunset:    { bg: "EA580C", title: "FFFFFF", text: "FFF7ED", accent: "FFFFFF", sep: "FFFFFF", font: "Arial" },
        cyber_neon:        { bg: "1E1B4B", title: "F0ABFC", text: "FFFFFF", accent: "F0ABFC", sep: "F0ABFC", font: "Arial" },
        professional_gray: { bg: "F1F5F9", title: "0F172A", text: "475569", accent: "0F172A", sep: "0F172A", font: "Arial" },
        emerald_forest:    { bg: "064E3B", title: "34D399", text: "FFFFFF", accent: "34D399", sep: "34D399", font: "Arial" },
        // legacy aliases
        clean:     { bg: "FFFFFF", title: "1A1A2E", text: "333333", accent: "4A90D9", sep: "4A90D9", font: "Arial" },
        dark:      { bg: "1A1A2E", title: "E94560", text: "EAEAEA", accent: "E94560", sep: "E94560", font: "Arial" },
        academic:  { bg: "0D3B66", title: "FAF0CA", text: "F4F1DE", accent: "F4D35E", sep: "F4D35E", font: "Arial" },
        corporate: { bg: "F5F5F5", title: "2D2D2D", text: "444444", accent: "9B2335", sep: "9B2335", font: "Arial" },
        eco:       { bg: "1B4332", title: "D8F3DC", text: "B7E4C7", accent: "52B788", sep: "52B788", font: "Arial" },
      };

      // Select theme — use nbBgColor/nbPanelColor/nbTitleColor overrides if present (NanoBanana custom)
      let T = SPEC_THEMES[theme] || SPEC_THEMES["clean_light"];
      if (nbBgColor)    T = { ...T, bg:    nbBgColor.replace("#", "").toUpperCase() };
      if (nbPanelColor) T = { ...T, accent: nbPanelColor.replace("#", "").toUpperCase(), sep: nbPanelColor.replace("#", "").toUpperCase() };
      if (nbTitleColor) T = { ...T, title: nbTitleColor.replace("#", "").toUpperCase() };
      if (customColor)  T = { ...T, accent: customColor.replace("#", "").toUpperCase(), sep: customColor.replace("#", "").toUpperCase() };

      const isRtlSlide = (s: any) => s.direction === "rtl" || hasArabic;
      const align = (s: any) => isRtlSlide(s) ? "right" : "left";

      pptx.layout = "LAYOUT_WIDE"; // 10 x 7.5 inches

      // ── Shared helper: add bg + separator bar ─────────────────────────────
      const addBgSep = (slide: any, sepY = 1.45) => {
        slide.background = { color: T.bg };
        slide.addShape(pptx.ShapeType.rect as any, {
          x: 0.4, y: sepY, w: 9.2, h: 0.025, fill: { color: T.sep }
        });
      };

      const addTitle = (slide: any, text: string, s: any, y = 0.25, size = 32) => {
        const opts: any = {
          x: 0.4, y, w: 9.2, h: 1.0,
          fontSize: size, bold: true, color: T.title,
          align: align(s), valign: "middle", shrinkText: true,
          fontFace: T.font,
        };
        if (isRtlSlide(s)) opts.rtlMode = true;
        slide.addText(text, opts);
      };

      const addFooter = (slide: any, idx: number) => {
        try {
          slide.addShape(pptx.ShapeType.rect as any, { x: 0.4, y: 7.28, w: 0.05, h: 0.12, fill: { color: T.accent } });
          slide.addShape(pptx.ShapeType.rect as any, { x: 0.4, y: 7.25, w: 0.12, h: 0.03, fill: { color: T.accent } });
        } catch {}
        slide.addText("LECTUREMATE AI", { x: 0.65, y: 7.2, w: 4, h: 0.3, fontSize: 10, bold: true, color: T.text, align: "left", charSpacing: 4, fontFace: T.font });
        slide.addText(`${idx + 1}`, { x: 6.8, y: 7.1, w: 3.0, h: 0.3, fontSize: 12, bold: true, color: T.text, align: "right", charSpacing: 2, fontFace: T.font });
      };

      // ── Slide type builders ───────────────────────────────────────────────

      // INTRO: centered title + subtitle + separator
      const buildIntro = (pptxSlide: any, s: any) => {
        pptxSlide.background = { color: T.bg };
        const titleOpts: any = { x: 0.8, y: 2.0, w: 8.4, h: 1.7, fontSize: 44, bold: true, color: T.title, align: "center", valign: "middle", shrinkText: true, fontFace: T.font };
        if (isRtlSlide(s)) titleOpts.rtlMode = true;
        pptxSlide.addText(s.title, titleOpts);
        pptxSlide.addShape(pptx.ShapeType.rect as any, { x: 2.5, y: 3.95, w: 5.0, h: 0.025, fill: { color: T.sep } });
        if (s.subtitle) {
          const subOpts: any = { x: 0.8, y: 4.15, w: 8.4, h: 1.0, fontSize: 22, color: T.text, align: "center", valign: "top", fontFace: T.font };
          if (isRtlSlide(s)) subOpts.rtlMode = true;
          pptxSlide.addText(s.subtitle, subOpts);
        }
      };

      // SECTION: centered large title only (topic divider)
      const buildSection = (pptxSlide: any, s: any) => {
        pptxSlide.background = { color: T.bg };
        pptxSlide.addShape(pptx.ShapeType.rect as any, { x: 0, y: 0, w: 10, h: 7.5, fill: { color: T.accent, transparency: 90 } });
        const opts: any = { x: 0.8, y: 2.8, w: 8.4, h: 1.8, fontSize: 38, bold: true, color: T.accent, align: "center", valign: "middle", shrinkText: true, fontFace: T.font };
        if (isRtlSlide(s)) opts.rtlMode = true;
        pptxSlide.addText(s.title, opts);
      };

      // CONTENT / SUMMARY: title + separator + bullet list
      const buildContent = (pptxSlide: any, s: any, idx: number) => {
        addBgSep(pptxSlide);
        addTitle(pptxSlide, s.title, s);
        
        const imgPath = slideImages[String(idx)];
        const hasImage = imgPath && existsSync(imgPath);
        
        const bullets = s.bullets.map((b: string) => ({
          text: isRtlSlide(s) ? (b + " •") : ("• " + b),
          options: { breakLine: true, paraSpaceAfter: 8 }
        }));
        
        const textW = hasImage ? 4.8 : 9.2;
        const textX = hasImage && isRtlSlide(s) ? 4.8 : 0.4;
        
        const bOpts: any = {
          x: textX, y: 1.55, w: textW, h: 5.5,
          fontSize: 18, color: T.text, align: align(s), valign: "top",
          lineSpacing: 26, shrinkText: true, wrap: true, fontFace: T.font,
        };
        
        if (isRtlSlide(s)) { bOpts.rtlMode = true; bOpts.isTextBox = true; }
        if (bullets.length > 0) pptxSlide.addText(bullets, bOpts);
        
        if (hasImage) {
          const imgX = isRtlSlide(s) ? 0.4 : 5.4;
          pptxSlide.addImage({ path: imgPath, x: imgX, y: 1.6, w: 4.2, h: 5.2, sizing: { type: "contain" } });
        }
        
        addFooter(pptxSlide, idx);
      };

      // QUOTE: title + separator + centered italic quote
      const buildQuote = (pptxSlide: any, s: any, idx: number) => {
        addBgSep(pptxSlide);
        addTitle(pptxSlide, s.title, s);
        
        const imgPath = slideImages[String(idx)];
        const hasImage = imgPath && existsSync(imgPath);
        
        const textW = hasImage ? 4.8 : 7.6;
        const textX = hasImage ? (isRtlSlide(s) ? 4.8 : 0.4) : 1.2;
        
        const q = `"${s.quote || ""}"`;
        const qOpts: any = {
          x: textX, y: 2.5, w: textW, h: 3.0,
          fontSize: 24, italic: true, color: T.accent, align: "center", valign: "middle",
          wrap: true, shrinkText: true, fontFace: T.font,
        };
        if (isRtlSlide(s)) qOpts.rtlMode = true;
        pptxSlide.addText(q, qOpts);
        
        if (hasImage) {
          const imgX = isRtlSlide(s) ? 0.4 : 5.4;
          pptxSlide.addImage({ path: imgPath, x: imgX, y: 1.6, w: 4.2, h: 5.2, sizing: { type: "contain" } });
        }
        
        addFooter(pptxSlide, idx);
      };

      // STATS: title + 3 accent boxes with value + label
      const buildStats = (pptxSlide: any, s: any, idx: number) => {
        addBgSep(pptxSlide);
        addTitle(pptxSlide, s.title, s);
        const stats = (s.stats || []).slice(0, 3);
        stats.forEach((stat: any, i: number) => {
          const left = 0.4 + i * 3.1;
          const colW = 2.8;
          pptxSlide.addShape(pptx.ShapeType.rect as any, { x: left, y: 2.3, w: colW, h: 1.6, fill: { color: T.accent } });
          pptxSlide.addText(String(stat.value || ""), { x: left, y: 2.35, w: colW, h: 1.5, fontSize: 44, bold: true, color: T.bg, align: "center", valign: "middle", fontFace: T.font });
          const lOpts: any = { x: left, y: 4.05, w: colW, h: 0.9, fontSize: 16, color: T.text, align: "center", valign: "top", wrap: true, fontFace: T.font };
          if (isRtlSlide(s)) lOpts.rtlMode = true;
          pptxSlide.addText(String(stat.label || ""), lOpts);
        });
        addFooter(pptxSlide, idx);
      };

      // COMPARISON: title + center divider + two columns
      const buildComparison = (pptxSlide: any, s: any, idx: number) => {
        addBgSep(pptxSlide);
        addTitle(pptxSlide, s.title, s);
        // Center divider
        pptxSlide.addShape(pptx.ShapeType.rect as any, { x: 4.95, y: 1.7, w: 0.025, h: 5.5, fill: { color: T.sep } });
        const sides = [
          { label: s.left_label, points: s.left_points, x: 0.4, w: 4.3 },
          { label: s.right_label, points: s.right_points, x: 5.2, w: 4.3 },
        ];
        sides.forEach(({ label, points, x, w }) => {
          const hOpts: any = { x, y: 1.7, w, h: 0.7, fontSize: 20, bold: true, color: T.accent, align: "center", valign: "middle", fontFace: T.font };
          if (isRtlSlide(s)) hOpts.rtlMode = true;
          pptxSlide.addText(label || "", hOpts);
          const ptTexts = (points || []).map((p: string) => ({
            text: isRtlSlide(s) ? (p + " •") : ("• " + p),
            options: { breakLine: true, paraSpaceAfter: 6 }
          }));
          if (ptTexts.length > 0) {
            const pOpts: any = { x, y: 2.55, w, h: 4.5, fontSize: 16, color: T.text, align: align(s), valign: "top", wrap: true, shrinkText: true, fontFace: T.font };
            if (isRtlSlide(s)) { pOpts.rtlMode = true; pOpts.isTextBox = true; }
            pptxSlide.addText(ptTexts, pOpts);
          }
        });
        addFooter(pptxSlide, idx);
      };

      // ── Build each slide ──────────────────────────────────────────────────
      slides.forEach((slide: any, idx: number) => {
        const pptxSlide = pptx.addSlide();
        const t = slide.type;
        if      (t === "intro")      buildIntro(pptxSlide, slide);
        else if (t === "section")    buildSection(pptxSlide, slide);
        else if (t === "quote")      buildQuote(pptxSlide, slide, idx);
        else if (t === "stats")      buildStats(pptxSlide, slide, idx);
        else if (t === "comparison") buildComparison(pptxSlide, slide, idx);
        else                         buildContent(pptxSlide, slide, idx); // content + summary

      }); // end slides.forEach (new spec builder)




            // Generate buffer
      let buffer: Buffer;
      try {
        const pptxBuffer = await pptx.write({ outputType: "nodebuffer" });
        // Ensure it's a Buffer
        buffer = Buffer.isBuffer(pptxBuffer) ? pptxBuffer : Buffer.from(pptxBuffer as any);
      } catch (writeError: any) {
        console.error("[API] Error writing PPTX buffer:", writeError);
        throw new Error(`Failed to write PowerPoint: ${writeError.message}`);
      }

      if (!buffer || buffer.length === 0) {
        throw new Error("Generated PowerPoint buffer is empty");
      }

      // Support Arabic in filename using RFC 5987 encoding
      const hasArabicInTitle = /[\u0600-\u06FF]/.test(lectureTitle || "");

      // Create safe ASCII filename for basic header
      const asciiFilename = (lectureTitle || "lecture_slides")
        .replace(/[^\x20-\x7E]/g, "") // Remove all non-ASCII characters
        .replace(/[^a-z0-9\s-]/gi, "_")
        .replace(/\s+/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_+|_+$/g, "")
        .substring(0, 100) || "lecture_slides";

      const filename = `${asciiFilename}_slides.pptx`;

      // Use RFC 5987 encoding for Arabic filenames
      let contentDisposition: string;
      if (hasArabicInTitle) {
        // RFC 5987: filename*=UTF-8''encoded-filename
        const encodedFilename = encodeURIComponent(`${lectureTitle}_slides.pptx`);
        contentDisposition = `attachment; filename="${filename}"; filename*=UTF-8''${encodedFilename}`;
      } else {
        contentDisposition = `attachment; filename="${filename}"`;
      }

      console.log("[PPTX] Original title:", lectureTitle);
      console.log("[PPTX] Has Arabic:", hasArabicInTitle);
      console.log("[PPTX] Content-Disposition:", contentDisposition);

      // Send file with properly encoded filename
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.presentationml.presentation");
      res.setHeader("Content-Disposition", contentDisposition);
      res.send(buffer);
    } catch (error: any) {
      console.error("[API] Error generating PPTX:", error);
      console.error("[API] Error stack:", error.stack);
      return res.status(500).json({
        error: "Failed to generate PowerPoint file",
        details: error.message || "Unknown error occurred",
      });
    }
  });

  /**
   * Nano Banana - Unified Generation Endpoint
   * POST /api/nano-banana/generate
   */
  app.post("/api/nano-banana/generate", async (req: Request, res: Response) => {
    try {
      const { jobType, sourceFileId, topic, theme, visualStyle, layoutStyle } = req.body;

      if (!jobType || !sourceFileId) {
        return res.status(400).json({ error: "jobType and sourceFileId are required" });
      }

      console.log(`[NanoBanana] Starting ${jobType} generation for file ${sourceFileId}`);

      if (jobType === "video") {
        // Mock video job creation
        return res.json({
          success: true,
          jobId: `NBV-${Date.now()}`,
          message: "Video summary generation started. You will be notified when it is ready.",
          estimatedTime: "2-5 minutes"
        });
      } else {
        // PPT job - redirected logic or similar
        return res.json({
          success: true,
          jobId: `NBP-${Date.now()}`,
          message: "PowerPoint generation initialized with AI images."
        });
      }
    } catch (error: any) {
      console.error("[NanoBanana] Generation error:", error);
      res.status(500).json({ error: "Failed to initialize Nano Banana engine" });
    }
  });

  // use storage to perform CRUD operations on the storage interface
  // e.g. storage.insertUser(user) or storage.getUserByUsername(username)


  app.post("/api/ai/agent-chat", async (req: Request, res: Response) => {
    try {
      const { transcript, message, history, mode = "api", image, relatedLectures } = req.body as {
        transcript: string;
        message: string;
        history: { role: string; content: string }[];
        mode?: "gpu" | "api";
        image?: string;
        relatedLectures?: { id: string; title: string; summary?: string; category?: string; sourceType?: string }[];
      };

      if (!message && !image) {
        return res.status(400).json({ error: "Message or image is required" });
      }

      const geminiApiKey = process.env.GEMINI_API_KEY;
      if (!geminiApiKey) {
        return res.status(500).json({ error: "Gemini API key not configured" });
      }

      const genAI = new GoogleGenerativeAI(geminiApiKey);
      const isArabic = /[\u0600-\u06FF]/.test(message || "") || /[\u0600-\u06FF]/.test(transcript.substring(0, 100));

      // Build related lectures context block
      let relatedLecturesBlock = "";
      if (relatedLectures && relatedLectures.length > 0) {
        if (isArabic) {
          relatedLecturesBlock = `\n\n--- محاضرات أخرى للمستخدم (السياق المشترك) ---\nالمستخدم لديه المحاضرات التالية في المنصة. إذا وجدت صلةً بين سؤاله والمحاضرات الأخرى، أشر إليها بوضوح.\n${relatedLectures.map(l => `• "${l.title}" (${l.sourceType || 'unknown'}, تصنيف: ${l.category || 'عام'}):\n  ${l.summary ? l.summary.substring(0, 300) : 'لا يوجد ملخص'}`).join('\n')}\n---`;
        } else {
          relatedLecturesBlock = `\n\n--- Other Lectures in User's Library (Cross-Lecture Context) ---\nThe user also has these other lectures. If their question has a relevant connection to any of them, proactively mention it with the exact lecture title.\n${relatedLectures.map(l => `• "${l.title}" (${l.sourceType || 'unknown'}, category: ${l.category || 'general'}):\n  ${l.summary ? l.summary.substring(0, 300) : 'No summary available'}`).join('\n')}\n---`;
        }
      }

      const systemPrompt = isArabic
        ? `أنت المنسق الأكاديمي "Academic Luminary" المدمج في LectureMate. تهدف إلى مساعدة الطلاب على فهم المحاضرة بعمق.
        
نص المحاضرة الحالية:
${transcript.substring(0, 28000)}
${relatedLecturesBlock}

القواعد الأساسية:
1. أجب فقط على الأسئلة المتعلقة بالمحاضرة أو المواضيع المرتبطة بها بشكل مباشر. وإذا كان السؤال خارج النطاق تماماً، اعتذر بلباقة موضحاً أنك مخصص للمحتوى الأكاديمي فقط.
2. اشرح أي سؤال يُطرح عليك **شرحاً مفصلاً ودقيقاً جداً**. لا تترك أي نقطة غامضة، وفكك المعلومات إلى خطوات واضحة باستخدام الفقرات والنقاط التوضيحية لتغطي كل تفصيلة تتعلق بالموضوع.
3. أي معادلات أو قوانين رياضية أو فيزيائية يجب كتابتها بصيغة LaTeX الصارمة (مغلفة بـ $ للمعادلة المدمجة في النص، وبـ $$ للمعادلة المستقلة) حتى يسهل فهمها وحفظها.
4. أي أكواد برمجية يجب أن تكون مكتوبة داخل كتل Markdown ملونة ومناسبة للغتها البرمجية.
5. **إذا كان موضوع السؤال مرتبطاً بمحاضرة أخرى في مكتبة المستخدم، أشر إليها صراحةً** مستخدماً هذا التنسيق: 📚 *ملاحظة: هذا المفهوم يرتبط أيضاً بمحاضرة "[اسم المحاضرة]" في مكتبتك.*
6. نسق إجابتك بطريقة احترافية وفاخرة.`
        : `You are the "Academic Luminary" Agent integrated into LectureMate. Your purpose is to help students deeply understand the lecture material.
        
Current Lecture Transcript:
${transcript.substring(0, 28000)}
${relatedLecturesBlock}

Important Rules:
1. Answer ONLY questions related to the uploaded lecture or closely related academic topics. If a question is completely irrelevant, politely decline and steer the user back to the academic context.
2. Explain every answer in **extreme detail**. Be exhaustive, step-by-step, and do not leave out any relevant point. Break down complex topics into perfectly structured markdown lists and paragraphs.
3. Output ALL mathematical formulas, laws, and equations strictly using LaTeX format (enclose inline math in $...$ and block math in $$...$$) to ensure they are easily readable and memorizable.
4. Output ALL programming code as syntax-highlighted Markdown code blocks.
5. **If the user's question is connected to another lecture in their library, proactively mention it** using this exact format: 📚 *Note: This concept is also covered in your lecture **"[Lecture Title]"** — you may want to review it for a deeper understanding.*
6. Keep your formatting highly professional.`;

      const promptParts: any[] = [{ text: systemPrompt }];

      if (history.length > 0) {
        promptParts.push({ text: `Here is the conversation history:\n${history.map(m => `${m.role === 'ai' ? 'Agent' : 'User'}: ${m.content}`).join('\n')}` });
      }

      if (image && image.startsWith("data:")) {
        const m = image.match(/^data:([^;]+);base64,(.+)$/);
        if (m) {
          promptParts.push({
            inlineData: {
              data: m[2],
              mimeType: m[1]
            }
          });
          promptParts.push({ text: `User has provided an image. Please analyze it in the context of the lecture if possible. User message: ${message || "Explain this image."}` });
        } else {
          promptParts.push({ text: `User message: ${message}` });
        }
      } else {
        promptParts.push({ text: `User: ${message}` });
      }

      const text = await callGeminiWithRetry(genAI, promptParts, "gemini-2.5-flash");
      res.json({ reply: text });
    } catch (error: any) {
      console.error("[API] Error in agent chat:", error);
      res.status(500).json({ error: "Failed to generate reply", details: error.message });
    }
  });

  // Generate document content with AI
  app.post("/api/ai/generate-document", async (req: Request, res: Response) => {
    try {
      const { prompt, images, contentImages, hasTemplate } = req.body as {
        prompt: string;
        images?: string[];          // all images (template first if hasTemplate, then content)
        contentImages?: string[];   // only the content/figure images
        hasTemplate?: boolean;
      };

      if (!prompt) {
        return res.status(400).json({ error: "Prompt is required" });
      }

      const geminiApiKey = process.env.GEMINI_API_KEY;
      if (!geminiApiKey) {
        return res.status(500).json({ error: "Gemini API key not configured" });
      }

      const genAI = new GoogleGenerativeAI(geminiApiKey);

      // ── Parse ALL image parts (template + content) for vision ──
      const allImageParts: any[] = [];
      for (const image of images || []) {
        if (image && image.startsWith("data:")) {
          const m = image.match(/^data:([^;]+);base64,(.+)$/);
          if (m) allImageParts.push({ inlineData: { data: m[2], mimeType: m[1] } });
        }
      }

      // ── Embed content images as base64 <img> tags in extra instructions ──
      let contentImageInstructions = "";
      if (contentImages && contentImages.length > 0) {
        contentImageInstructions = `\n\nEMBEDDED CONTENT IMAGES:\nInsert the following images as <figure> elements with <figcaption> at appropriate locations in the document. Use these exact base64 src values:\n`;
        contentImages.forEach((img, i) => {
          if (img && img.startsWith("data:")) {
            contentImageInstructions += `\nFigure ${i + 1}: <figure><img src="${img}" alt="Figure ${i + 1}" style="max-width:100%;border-radius:8px;margin:16px 0;"><figcaption>Figure ${i + 1}: [Write relevant caption here]</figcaption></figure>`;
          }
        });
      }

      const templateInstruction = hasTemplate
        ? `\nDESIGN: The FIRST image provided is a design template — replicate its CSS layout, color scheme, fonts, header/footer style, and overall visual structure in your HTML output.`
        : `\nDESIGN: Use a clean, professional HTML layout with embedded CSS (white background, readable fonts, clear headings, good spacing).`;

      const fullPrompt = prompt + templateInstruction + contentImageInstructions + `\n\nIMPORTANT: Return ONLY raw HTML (<!DOCTYPE html>...). No markdown, no code fences, no explanations.`;

      const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

      let result;
      if (allImageParts.length > 0) {
        result = await model.generateContent([fullPrompt, ...allImageParts]);
      } else {
        result = await model.generateContent(fullPrompt);
      }

      const raw = result.response.text().trim();
      const cleanHtml = raw.replace(/```html\n?/gi, "").replace(/```\n?/g, "").trim();

      res.json({ content: cleanHtml, htmlContent: cleanHtml });
    } catch (error: any) {
      console.error("[API] Error generating document:", error);
      res.status(500).json({ error: "Failed to generate document", details: error.message });
    }
  });

  return httpServer;
}

