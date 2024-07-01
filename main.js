const express = require('express');
const WebSocket = require('ws');
const OpenAI = require('openai');
const axios = require('axios');
const mongoose = require('mongoose');
require('dotenv').config();

const app = express();
const port = 5000;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI);

const messageSchema = new mongoose.Schema({
  flex360Id: String,
  role: String,
  content: String,
  timestamp: { type: Date, default: Date.now }
});

const Message = mongoose.model('Message', messageSchema);

// Save message to DB
const saveMessage = async (flex360Id, role, content) => {
  const message = new Message({ flex360Id, role, content });
  await message.save();
};

const wss = new WebSocket.Server({ noServer: true });

const userConnections = new Map();
const adminConnections = new Map();

async function fetchUserData(flex360Id) {
  console.log(`Attempting to fetch user data for FLEX360_ID: ${flex360Id}`);
  try {
    const response = await axios.post('https://test.attflex.com/flex360/opera/api/flexuser', 
      `flex360_id=${flex360Id}`,
      {
        headers: {
          'authtoken': 'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJ1c2VyIjoiQVRUQ2FsbFZ1IiwibmFtZSI6IkFUVCBDYWxsIFZ1IiwicGFzc3dvcmQiOm51bGwsIkFQSV9USU1FIjoxNjkxNTE2MDMxfQ.tBRxp40WbFSkzaJyXXzgKhM5Cxt4zz6RRqGlgwQVlJk',
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json'
        }
      }
    );
    console.log('User data fetched successfully:', response.data);
    return response.data;
  } catch (error) {
    console.error('Error fetching user data:', error.response ? error.response.data : error.message);
    return null;
  }
}

wss.on('connection', (ws, req) => {
  console.log('New WebSocket connection established');
  let userData = null;
  let isWaitingForId = true;
  let isAdmin = false;
  let flex360Id = null;

  ws.send("Welcome! Please provide your FLEX360_ID to get started.");

  ws.on('message', async (message) => {
    console.log('Received message:', message.toString());
    try {
      const userMessage = message.toString();

      if (isWaitingForId) {
        if (userMessage.startsWith("admin:")) {
          isAdmin = true;
          flex360Id = userMessage.split(":")[1];
          if (userConnections.has(flex360Id)) {
            adminConnections.set(flex360Id, ws);
            ws.send(`Connected to user ${flex360Id}`);
            const oldConversations = await fetchOldConversations(flex360Id);
            oldConversations.forEach(msg => ws.send(`${msg.role}: ${msg.content}`));
            ws.send("You can now send messages to the user.");
          } else {
            ws.send("User not found.");
          }
          isWaitingForId = false;
        } else {
          console.log('Attempting to fetch user data for ID:', userMessage);
          userData = await fetchUserData(userMessage);
          console.log('Fetched user data:', userData);
          if (userData && userData.FLEX360_ID) {
            console.log('User data fetched successfully. Switching to chat mode.');
            userConnections.set(userMessage, ws);
            flex360Id = userMessage;
            isWaitingForId = false;
            ws.send("Thank you. Your data has been fetched. How can I assist you today?");
          } else {
            console.log('Failed to fetch user data. Asking for FLEX360_ID again.');
            ws.send("I'm sorry, I couldn't fetch your data. Please try again with a valid FLEX360_ID.");
          }
        }
        return;
      }

      if (isAdmin) {
        if (userMessage.startsWith("disconnect:")) {
          const targetFlex360Id = userMessage.split(":")[1];
          if (adminConnections.has(targetFlex360Id)) {
            adminConnections.delete(targetFlex360Id);
            ws.send(`Disconnected from user ${targetFlex360Id}`);
          }
        } else {
          const userWs = userConnections.get(flex360Id);
          if (userWs) {
            userWs.send(`Admin: ${userMessage}`);
            saveMessage(flex360Id, 'admin', userMessage);
          }
        }
      } else {
        if (adminConnections.has(flex360Id)) {
          const adminWs = adminConnections.get(flex360Id);
          if (adminWs) {
            adminWs.send(`User: ${userMessage}`);
          }
        } else {
          const context = `User data: ${JSON.stringify(userData)}
User query: ${userMessage}
Please provide a response based on the user's data and query. If the query is about information contained in the user data, use that information in your response. Always refer to the user data when answering questions about the user's details.`;

          console.log('Sending context to OpenAI:', context);

          const response = await openai.chat.completions.create({
            model: "gpt-3.5-turbo",
            messages: [
              { role: "system", content: "You are a helpful assistant with access to user data. Provide accurate information based on the user's data when relevant. Always use the provided user data to answer questions about the user's details." },
              { role: "user", content: context }
            ],
          });

          const botMessage = response.choices[0].message.content;
          console.log('Received response from OpenAI:', botMessage);
          ws.send(botMessage);
          saveMessage(flex360Id, 'user', userMessage);
          saveMessage(flex360Id, 'bot', botMessage);

          if (adminConnections.has(flex360Id)) {
            const adminWs = adminConnections.get(flex360Id);
            if (adminWs) {
              adminWs.send(`User: ${userMessage}`);
              adminWs.send(`Bot: ${botMessage}`);
            }
          }
        }
      }
    } catch (error) {
      console.error('Error processing message:', error);
      ws.send('An error occurred while processing your request.');
    }
  });
});

// Add this function to fetch old conversations
async function fetchOldConversations(flex360Id) {
  return await Message.find({ flex360Id }).sort({ timestamp: 1 }).exec();
}

app.use(express.static('public'));

const server = app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});

server.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});