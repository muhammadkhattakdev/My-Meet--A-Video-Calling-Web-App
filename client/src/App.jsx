import { AppProvider } from './context/context';
import Router from './components/router';
import './app.css';

function App() {
  return (
    <AppProvider>
      <Router />
    </AppProvider>
  );
}

export default App;