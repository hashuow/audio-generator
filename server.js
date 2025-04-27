const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const admin = require('firebase-admin');
const multer = require('multer');
const os = require('os');
const fs = require('fs');
const axios = require('axios');
const FormData = require('form-data');

const PORT = process.env.PORT || 8080;
const app = express();

// ✅ Load Firebase service account key
const serviceAccount = require("./serviceAccountKey.json");

// ✅ Initialize Firebase Admin
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  storageBucket: "deefake-20283.firebasestorage.app" // ✅ Fixed bucket name
});

const db = admin.firestore();
const bucket = admin.storage().bucket();

// Setup Multer to store file temporarily
const upload = multer({ dest: os.tmpdir() });

// Create HTTP server
const server = http.createServer(app);

// Attach WebSocket server
const wss = new WebSocket.Server({ server });

// 🔥 WebSocket Handling
wss.on('connection', (ws) => {
  console.log('Twilio connected to WebSocket');

  ws.on('message', async (data) => {
    const message = JSON.parse(data);

    if (message.event === 'start') {
      console.log('Streaming started');
      await db.collection('websocket-logs').add({
        event: 'start',
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      });
    } else if (message.event === 'media') {
      const audioData = Buffer.from(message.media.payload, 'base64');
      console.log('Received audio chunk:', audioData.length);
      await db.collection('websocket-logs').add({
        event: 'media',
        chunkSize: audioData.length,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      });
    } else if (message.event === 'stop') {
      console.log('Streaming stopped');
      await db.collection('websocket-logs').add({
        event: 'stop',
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
  });

  ws.on('close', () => {
    console.log('WebSocket closed');
  });
});

// Health check route
app.get('/', (req, res) => {
  res.send('WebSocket Server is running!');
});

// 🔥 Firestore health check endpoint
app.get('/firestore-status', async (req, res) => {
  try {
    console.log("Inside /firestore-status API");
    const docRef = db.collection('health').doc('1');
    const doc = await docRef.get();

    if (doc.exists) {
      console.log('Document found:', doc.data());
      res.json({ status: 'connected', data: doc.data() });
    } else {
      console.log('No such document! Creating now...');
      await docRef.set({
        status: 'OK',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      const newDoc = await docRef.get();
      res.json({ status: 'created', data: newDoc.data() });
    }
  } catch (error) {
    console.error('Firestore status check error:', error);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

const userFcmToken = 'djnzemBzTreCgo5hw5ADF8:APA91bHE327taVhIN4yqwM6R_gl_YsLDwEgi2j-D0CynBa0r0Ve6SapWM8elNrdCRwFvhU4LYJSI9B6atTPIhGuyXpNCOLO9MTm0zajOTJ4MOtIscbdH254';

const { v4: uuidv4 } = require('uuid');

app.post('/upload', upload.single('audio'), async (req, res) => {
  try {
    const file = req.file;
    const userId = req.body.userId;

    if (!file || !userId) {
      return res.status(400).json({ message: 'Audio file and userId are required.' });
    }

    const fileName = `${Date.now()}_${file.originalname.replace(/\s+/g, '_')}`;
    const storagePath = `uploads/${userId}/${fileName}`;

    const bucket = admin.storage().bucket();
    const token = uuidv4(); // 🔥 Generate a public token

    await bucket.upload(file.path, {
      destination: storagePath,
      metadata: {
        contentType: file.mimetype,
        metadata: {
          firebaseStorageDownloadTokens: token,
        },
      },
    });

    // ✅ Correct Public URL
    const fileUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(storagePath)}?alt=media&token=${token}`;

    // ✅ Save into Firestore
    const docRef = await db.collection('audio_files').add({
      fileName: fileName,
      filePath: storagePath,
      location: 'Australia',
      status: 'processing',
      uploadedAt: admin.firestore.FieldValue.serverTimestamp(),
      fileUrl: fileUrl,
      userId: userId,
    });

    const docId = docRef.id;

    // ✅ Now send to Predict API
    const predictResult = await sendToPredictApi(file.path);

   // ✅ Decide the new status
    let newStatus = 'real';
    if (predictResult && predictResult.real === false) {
    newStatus = 'fake';
    console.log('Fake voice detected. Sending push notification...');
    await sendPushNotification(userFcmToken);
    } else {
    console.log('Voice is real. No notification sent.');
    }

    // ✅ Update the Firestore document
    await db.collection('audio_files').doc(docId).update({
    status: newStatus,
    predictionResult: predictResult, // optional: store full response if needed
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ message: 'Upload completed', docId: docId, fileUrl: fileUrl, predictResult: predictResult });

  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ message: 'Upload failed', error: error.message });
  }
});

// 🔥 Helper function to send file to predict API
async function sendToPredictApi(filePath) {
    try {
      const formData = new FormData();
      formData.append('audio', fs.createReadStream(filePath), {
        filename: 'audio.mp3', // ✅ Match your file type (e.g., .mp3 if it's .mp3)
        contentType: 'audio/mpeg' // ✅ Correct MIME type like your curl
      });
  
      const response = await axios.post('http://localhost:8000/predict/', formData, {
        headers: {
          ...formData.getHeaders(),
          'Accept': 'application/json' // ✅ match the curl header too
        },
      });
  
      console.log('Predict API response:', response.data);
      return response.data;
    } catch (error) {
      console.error('Predict API call failed:', error.message);
      return { real: false, error: error.message };
    }
}

async function sendPushNotification(fcmToken) {
    const message = {
      token: fcmToken,
      notification: {
        title: 'Fake Voice Detected!',
        body: 'We detected a fake voice. Please check it immediately!',
      },
      android: {
        priority: 'high', // ✅ High priority for Android
        notification: {
          sound: 'default', // ✅ Play notification sound
        },
      },
      apns: {
        headers: {
          'apns-priority': '10', // ✅ High priority for iOS (if you also later support iOS)
        },
        payload: {
          aps: {
            sound: 'default',
          },
        },
      },
    };
  
    try {
      const response = await admin.messaging().send(message);
      console.log('✅ Notification sent successfully:', response);
    } catch (error) {
      console.error('❌ Error sending notification:', error.message);
    }
  }
  
  

// Start server
server.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});
