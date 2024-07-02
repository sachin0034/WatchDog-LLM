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

// Connect to MongoDB using Mongoose
mongoose.connect(process.env.MONGO_URI);

// Defining MongoDB schema for messages
const messageSchema = new mongoose.Schema({
  flex360Id: String,
  role: String,
  content: String,
  timestamp: { type: Date, default: Date.now }
});

const Message = mongoose.model('Message', messageSchema);  // Creating Message model for MongoDB

// Function to save a message to MongoDB
const saveMessage = async (flex360Id, role, content) => {
  const message = new Message({ flex360Id, role, content });
  await message.save();
};

const wss = new WebSocket.Server({ noServer: true });  // (wss) without directly attaching it to an HTTP server.


// When a WebSocket connection is established ('connection' event), you store the WebSocket instance (ws) in the appropriate map based on whether it's a user or admin connection.
const userConnections = new Map();  // Map to store user WebSocket connections
const adminConnections = new Map();  // Map to store admin WebSocket connections

// Function to fetch user data from an external API
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

// WebSocket server connection handling
// During message handling or other interactions, you retrieve WebSocket instances from these maps using the flex360Id as a key. This allows you to send messages or perform actions specific to that user or admin.
wss.on('connection', (ws, req) => {
  console.log('New WebSocket connection established');
  let userData = null;  // Placeholder for user data fetched
  let isWaitingForId = true;  // Flag to indicate if waiting for user ID
  let isAdmin = false;  // Flag to indicate if user is admin
  let flex360Id = null;  // Placeholder for FLEX360_ID

  ws.send("Welcome! Please provide your FLEX360_ID to get started.");  // Initial message to client

  ws.on('message', async (message) => {
    console.log('Received message:', message.toString());
    try {
      const userMessage = message.toString();

      if (isWaitingForId) {
        if (userMessage.startsWith("admin:")) {  // Admin login process
          isAdmin = true;
          flex360Id = userMessage.split(":")[1];
          if (userConnections.has(flex360Id)) {  // Check if user is connected
            adminConnections.set(flex360Id, ws);  // Add admin connection to map
            ws.send(`Connected to user ${flex360Id}`);
            const oldConversations = await fetchOldConversations(flex360Id);  // Fetch old messages
            oldConversations.forEach(msg => ws.send(`${msg.role}: ${msg.content}`));  // Send old messages to admin
            ws.send("You can now send messages to the user.");
          } else {
            ws.send("User not found.");  // If user not found
          }
          isWaitingForId = false;  // End waiting for ID
        } else {  // Regular user login process
          console.log('Attempting to fetch user data for ID:', userMessage);
          userData = await fetchUserData(userMessage);  // Fetch user data from API
          console.log('Fetched user data:', userData);
          if (userData && userData.FLEX360_ID) {  // If valid user data fetched
            console.log('User data fetched successfully. Switching to chat mode.');
            userConnections.set(userMessage, ws);  // Add user connection to map
            flex360Id = userMessage;
            isWaitingForId = false;  // End waiting for ID
            ws.send("Thank you. Your data has been fetched. How can I assist you today?");
          } else {
            console.log('Failed to fetch user data. Asking for FLEX360_ID again.');
            ws.send("I'm sorry, I couldn't fetch your data. Please try again with a valid FLEX360_ID.");
          }
        }
        return;
      }

      if (isAdmin) {  // If user is admin
        if (userMessage.startsWith("disconnect:")) {  // Admin disconnect process
          const targetFlex360Id = userMessage.split(":")[1];
          if (adminConnections.has(targetFlex360Id)) {  // If admin connected to user
            adminConnections.delete(targetFlex360Id);  // Delete admin connection
            ws.send(`Disconnected from user ${targetFlex360Id}`);
          }
        } else {  // Admin sends message to user
          const userWs = userConnections.get(flex360Id);
          if (userWs) {
            userWs.send(`Admin: ${userMessage}`);
            saveMessage(flex360Id, 'admin', userMessage);  // Save message to MongoDB
          }
        }
      } else {  // If user is not admin (regular user)
        if (adminConnections.has(flex360Id)) {  // If admin connected to user
          const adminWs = adminConnections.get(flex360Id);
          if (adminWs) {
            adminWs.send(`User: ${userMessage}`);
          }
        } else {  // Regular user sends message to bot
          const context = `User data: ${JSON.stringify(userData)}
User query: ${userMessage}
Please provide a response based on the user's data and query. If the query is about information contained in the user data, use that information in your response. Always refer to the user data when answering questions about the user's details.`;

          console.log('Sending context to OpenAI:', context);

          // Requesting AI response based on user query and context
          const response = await openai.chat.completions.create({
            model: "gpt-3.5-turbo",
            messages: [
              { role: "system", content: "You are a helpful assistant with access to user data. Provide accurate information based on the user's data when relevant. Always use the provided user data to answer questions about the user's details." },
              { role: "user", content: context }
            ],
          });

          const botMessage = response.choices[0].message.content;  // Getting AI response
          console.log('Received response from OpenAI:', botMessage);
          ws.send(botMessage);  // Sending AI response to user
          saveMessage(flex360Id, 'user', userMessage);  // Save user message to MongoDB
          saveMessage(flex360Id, 'bot', botMessage);  // Save AI response to MongoDB

          if (adminConnections.has(flex360Id)) {  // If admin connected to user
            const adminWs = adminConnections.get(flex360Id);
            if (adminWs) {
              adminWs.send(`User: ${userMessage}`);  // Sending user message to admin
              adminWs.send(`Bot: ${botMessage}`);  // Sending AI response to admin
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

// Function to fetch old conversations from MongoDB
async function fetchOldConversations(flex360Id) {
  return await Message.find({ flex360Id }).sort({ timestamp: 1 }).exec();
}

app.use(express.static('public'));  // Serving static files from 'public' directory

// Starting the Express server
const server = app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});

// Handling WebSocket upgrade requests
server.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});
