import { Telegraf } from 'telegraf';
import fetch from 'node-fetch';
import OpenAI from 'openai';
import cron from 'node-cron';
import cheerio from 'cheerio';
import fs from 'fs';
import path from 'path';

// Configura la clave API de OpenAI y Unsplash
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY, // Tu API Key de OpenAI
});

const unsplashAccessKey = process.env.UNSPLASH_ACCESS_KEY; // Clave de acceso de Unsplash

const sentNewsFilePath = path.join(process.cwd(), 'sent_news.txt'); // Archivo para almacenar enlaces de noticias enviadas

// Lista de diarios
const newsSources = [
  "https://elpais.com/",
  "https://www.elmundo.es/",
  "https://www.abc.es/",
  "https://www.lavanguardia.com/",
  "https://www.elconfidencial.com/",
  "https://www.elperiodico.com/es/",
  "https://www.clarin.com/",
  "https://www.lanacion.com.ar/",
  "https://www.infobae.com/",
  "https://www.eluniversal.com.mx/",
  "https://www.milenio.com/",
  "https://www.excelsior.com.mx/",
  "https://www.jornada.com.mx/",
  "https://elcomercio.pe/",
  "https://larepublica.pe/",
  "https://www.bbc.com/mundo",
  "https://www.univision.com/",
  "https://www.telemundo.com/"
];

// Función para obtener noticias de un portal específico
async function fetchNewsFromSource(url) {
  console.log(`Fetching news from: ${url}`);
  const response = await fetch(url);
  const body = await response.text();
  const $ = cheerio.load(body);

  const articles = [];

  $('article').each((index, element) => {
    const title = $(element).find('h2').text().trim();
    const summary = $(element).find('p').text().trim();
    let image = $(element).find('img').attr('src');
    const articleUrl = $(element).find('a').attr('href');

    if (image && !image.startsWith('data:') && !image.endsWith('.gif')) {
      image = new URL(image, url).href;
    } else {
      image = null;
    }

    // Verifica si la URL del artículo es relativa y conviértela en absoluta
    let fullArticleUrl;
    if (articleUrl) {
      fullArticleUrl = new URL(articleUrl, url).href;
    }

    if (title && summary && fullArticleUrl && !title.startsWith('Opinión')) { // Filtrar titulares vacíos y de opinión
      articles.push({ title, summary, image, url: fullArticleUrl });
    }
  });

  return articles;
}

// Función para buscar imágenes en Unsplash
async function searchImage(query) {
  console.log(`Searching image for: ${query}`);
  const searchUrl = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&client_id=${unsplashAccessKey}`;
  const response = await fetch(searchUrl);
  const data = await response.json();

  if (data.results && data.results.length > 0) {
    const imageUrl = data.results[0].urls.small;
    console.log(`Found image: ${imageUrl}`);
    return imageUrl;
  }

  console.log('No image found');
  return null;
}

// Función para cargar enlaces de noticias enviadas desde el archivo
function loadSentNews() {
  if (!fs.existsSync(sentNewsFilePath)) {
    return [];
  }
  const data = fs.readFileSync(sentNewsFilePath, 'utf8');
  return data.split('\n').filter(url => url.trim().length > 0);
}

// Función para guardar enlaces de noticias enviadas en el archivo
function saveSentNews(sentNews) {
  fs.writeFileSync(sentNewsFilePath, sentNews.join('\n'), 'utf8');
}

// Función para obtener una noticia relevante y generar una descripción detallada
async function getRelevantNews() {
  console.log('Fetching relevant news...');
  let allNews = [];
  for (const source of newsSources) {
    const news = await fetchNewsFromSource(source);
    allNews = allNews.concat(news);
  }

  const sentNews = loadSentNews();
  console.log(`Total news articles fetched: ${allNews.length}`);
  console.log(`Previously sent news count: ${sentNews.length}`);

  // Filtrar noticias ya enviadas
  const newNews = allNews.filter(article => !sentNews.includes(article.url));
  console.log(`New news articles count: ${newNews.length}`);

  if (newNews.length === 0) {
    return null;
  }

  // Seleccionar una noticia aleatoria
  const randomArticle = newNews[Math.floor(Math.random() * newNews.length)];

  const prompt = `Considera la siguiente noticia: "${randomArticle.title} - ${randomArticle.summary}". Proporciona una descripción más detallada de la noticia. Escribe de manera sensacionalista y llamativa, como un redactor de noticias. Si no hay suficiente información en el título, inventa detalles para que el artículo sea más atractivo. Asegúrate de que la descripción esté completa y no se corte a la mitad.`;
  const response = await openai.chat.completions.create({
    model: "gpt-3.5-turbo",
    messages: [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: prompt }
    ],
    max_tokens: 300 // Aumentar el límite de tokens permitidos
  });

  const detailedDescription = response.choices[0].message.content.trim();
  if (!randomArticle.image) {
    randomArticle.image = await searchImage(randomArticle.title);
  }
  console.log(`Selected article: ${randomArticle.title}`);

  // Agregar la noticia al registro de noticias enviadas
  sentNews.push(randomArticle.url);
  saveSentNews(sentNews);

  return { ...randomArticle, detailedDescription };
}

// Inicializa el bot de Telegram
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN); // Tu Telegram Bot Token
const channelId = process.env.CHANNEL_ID; // ID del canal de Telegram

// Comando /news
bot.command('news', async (ctx) => {
  console.log('Received /news command');
  try {
    const article = await getRelevantNews();
    if (article) {
      const message = `*${article.title}*\n\n${article.detailedDescription}\n\n[Leer más](${article.url})`;
      if (message.length > 1024) {
        await bot.telegram.sendMessage(channelId, message, { parse_mode: 'Markdown' });
      } else {
        if (article.image) {
          await bot.telegram.sendPhoto(channelId, article.image, { caption: message, parse_mode: 'Markdown' });
        } else {
          await bot.telegram.sendMessage(channelId, message, { parse_mode: 'Markdown' });
        }
      }
      console.log('News sent to channel.');
    } else {
      bot.telegram.sendMessage(channelId, 'No se encontraron noticias relevantes en este momento.');
    }
  } catch (error) {
    console.error('Error sending news:', error);
    bot.telegram.sendMessage(channelId, 'Hubo un error al obtener las noticias.');
  }
});

// Inicia el bot
bot.launch();
console.log('Bot started');

// Programa el envío automático de noticias cada 3 horas
cron.schedule('0 */3 * * *', async () => {
  console.log('Scheduled task triggered');
  try {
    const article = await getRelevantNews();
    if (article) {
      const message = `*${article.title}*\n\n${article.detailedDescription}\n\n[Leer más](${article.url})`;
      if (message.length > 1024) {
        await bot.telegram.sendMessage(channelId, message, { parse_mode: 'Markdown' });
      } else {
        if (article.image) {
          await bot.telegram.sendPhoto(channelId, article.image, { caption: message, parse_mode: 'Markdown' });
        } else {
          await bot.telegram.sendMessage(channelId, message, { parse_mode: 'Markdown' });
        }
      }
      console.log('News sent to channel.');
    } else {
      bot.telegram.sendMessage(channelId, 'No se encontraron noticias relevantes en este momento.');
    }
  } catch (error) {
    console.error('Error sending scheduled news:', error);
    bot.telegram.sendMessage(channelId, 'Hubo un error al obtener las noticias programadas.');
  }
});

