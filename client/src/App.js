import React from 'react';
import UserChat from './UserChat';
import AdminPanel from './AdminPanel';
import './App.css';

function App() {
  return (
    <div className="App">
      <h1>User Chat</h1>
      <UserChat />
      <h1>Admin Panel</h1>
      <AdminPanel />
    </div>
  );
}

export default App;
