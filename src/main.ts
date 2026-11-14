import { bootstrapApplication } from '@angular/platform-browser';
import { AppComponent } from './app/app.component';

bootstrapApplication(AppComponent)
  .then(() => {
    if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
      const swUrl = new URL('sw.js', document.baseURI).toString();
      navigator.serviceWorker.register(swUrl).catch(() => {});
    }
  })
  .catch(err => console.error(err));
