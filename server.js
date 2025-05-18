const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const admin = require('firebase-admin');
const multer = require('multer');
const os = require('os');
const fs = require('fs');
const axios = require('axios');
const FormData = require('form-data');
const { VoiceResponse } = require('twilio').twiml;
const serviceAccount = require("./serviceAccountKey.json");



const PORT = process.env.PORT || 8080;
const app = express();
app.use(express.json()); 
let twilioSocket = null;
let mobileSocket = null;


app.use((req, res, next) => {
  res.set('ngrok-skip-browser-warning', 'true');
  next();
});



// // Initialize Firebase Admin
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  storageBucket: "deefake-20283.firebasestorage.app" //  Fixed bucket name
 });

const db = admin.firestore();
const bucket = admin.storage().bucket();

// Setup Multer to store file temporarily
const upload = multer({ dest: os.tmpdir() });

// Create HTTP server
const server = http.createServer(app);

// Attach WebSocket server
const wss = new WebSocket.Server({ server });

// WebSocket Handling
wss.on('connection', (ws, req) => {
  console.log('New WebSocket connection');

  ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data);

      //  Identify source of connection
      if (message.type === 'client') {
        console.log(' React Native app connected');
        mobileSocket = ws;
        return;
      }

      if (message.event === 'start') {
        console.log(' Twilio stream started');
        twilioSocket = ws;

        await db.collection('websocket-logs').add({
          event: 'start',
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
        });
      }

      else if (message.event === 'media') {
        const audioBase64 = message.media.payload;
        const audioBuffer = Buffer.from(audioBase64, 'base64');
        console.log('Audio chunk received:', audioBuffer.length);

        // Log to Firestore
        await db.collection('websocket-logs').add({
          event: 'media',
          chunkSize: audioBuffer.length,
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
        });

        // Forward audio to React Native app
        if (mobileSocket && mobileSocket.readyState === WebSocket.OPEN) {
          mobileSocket.send(JSON.stringify({
            type: 'audio',
            payload: audioBase64, // Still base64 string
          }));
        }
      }

      else if (message.event === 'stop') {
        console.log('Twilio stream stopped');
        await db.collection('websocket-logs').add({
          event: 'stop',
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
        });

        if (mobileSocket && mobileSocket.readyState === WebSocket.OPEN) {
          mobileSocket.send(JSON.stringify({ type: 'end_stream' }));
        }
      }

    } catch (err) {
      console.error('Error handling message:', err.message);
    }
  });

  ws.on('close', () => {
    console.log(' WebSocket closed');
    if (ws === twilioSocket) {
      console.log(' Twilio socket closed');
      twilioSocket = null;
    } else if (ws === mobileSocket) {
      console.log(' Mobile socket closed');
      mobileSocket = null;
    }
  });
});
// Health check route
app.get('/', (req, res) => {
  res.send('WebSocket Server is running!');
});

//  Firestore health check endpoint
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



// Helper function to send file to predict API
async function sendToPredictApi(filePath) {
    try {
      const formData = new FormData();
      formData.append('audio', fs.createReadStream(filePath), {
        filename: 'audio.mp3', 
        contentType: 'audio/mpeg'
      });
  
      const response = await axios.post('http://localhost:8000/predict/', formData, {
        headers: {
          ...formData.getHeaders(),
          'Accept': 'application/json' 
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
        priority: 'high',
        notification: {
          sound: 'default', 
        },
      },
      apns: {
        headers: {
          'apns-priority': '10', 
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
      console.log('Notification sent successfully:', response);
    } catch (error) {
      console.error('Error sending notification:', error.message);
    }
  }
  
 

  app.post('/incoming-call', (req, res) => {
    const { from, to } = req.body;
  
    console.log(`Incoming call from ${from} to ${to}`);
  
    //  Broadcast to all connected WebSocket clients
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({
          type: 'incoming_call',
          from,
          to,
          time: new Date().toISOString(),
        }));
      }
    });
  
    res.sendStatus(200);
  });
  
  app.post('/recording', (req, res) => {
    const { url, from, time,to } = req.body;
  
    console.log(' Received new recording:', url);
  
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({
          type: 'recording',
          url,
          from,
          time,
          to
        }));
      }
    });
  
    res.sendStatus(200);
  });
  
// Start server
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server started on port ${PORT}`);
});