import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.js';
import { initLiff } from './lib/liff-auth.js';
import './index.css';

(async () => {
  try {
    await initLiff();
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </StrictMode>,
    );
  } catch {
    const root = document.getElementById('root')!;
    const container = document.createElement('div');
    container.style.padding = '2rem';
    container.style.fontFamily = 'sans-serif';
    container.style.color = '#b91c1c';

    const title = document.createElement('h1');
    title.style.fontSize = '1.25rem';
    title.style.marginBottom = '1rem';
    title.textContent = '起動できませんでした';

    const body = document.createElement('p');
    body.textContent = 'LIFFの起動に失敗しました。LINEのトークルームから開き直してください。';

    container.append(title, body);
    root.replaceChildren(container);
  }
})();
