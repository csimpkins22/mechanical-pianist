import './ui/styles.css';
import { App } from './app/App';
import { AppUI } from './ui/AppUI';

const loader = document.createElement('div');
loader.className = 'loader';
loader.innerHTML = `<div class="inner"><div class="eyebrow">A performance in real time</div><h1>The Mechanical Pianist</h1><div class="bar-out"><div class="bar-in"></div></div><div class="label"></div></div>`;
document.body.appendChild(loader);
const barIn = loader.querySelector('.bar-in') as HTMLDivElement;
const label = loader.querySelector('.label') as HTMLDivElement;

const app = new App(document.getElementById('stage') as HTMLCanvasElement, document.getElementById('ui') as HTMLElement);
(window as unknown as { app: App }).app = app;
if (app.params.get('ui') === '0') {
  document.body.classList.add('shot');
  loader.remove();
}

app
  .start((f, text) => {
    barIn.style.width = `${Math.round(f * 100)}%`;
    label.textContent = text;
  })
  .then(() => {
    const ui = new AppUI(app, document.getElementById('ui') as HTMLElement);
    ui.build();
    loader.classList.add('done');
    setTimeout(() => loader.remove(), 1600);
  })
  .catch((e) => {
    console.error(e);
    label.textContent = '';
    app.fail(e);
  });
