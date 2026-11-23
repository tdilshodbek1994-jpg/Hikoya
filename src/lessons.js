// Speaking darslari. Har bir darsda AI o'ynaydigan rol, ochilish gapi
// va o'quvchi aytishi kerak bo'lgan 6 ta ibora bor.
// Yangi dars qo'shish uchun shu ro'yxatga yangi obyekt qo'shing.

export const LESSONS = [
  {
    id: "cafe",
    title: "Kafeda",
    emoji: "☕",
    level: "A2",
    role: "a friendly barista in a small coffee shop",
    situation: "The student is a customer ordering a drink and a snack.",
    opener: "Hi there! Welcome in. What can I get for you today?",
    openerUz: "Salom! Xush kelibsiz. Sizga nima beray?",
    phrases: [
      { en: "Can I have a latte, please?", uz: "Menga latte bera olasizmi?" },
      { en: "What do you recommend?", uz: "Nimani tavsiya qilasiz?" },
      { en: "Could I get it to go?", uz: "Olib ketishga bera olasizmi?" },
      { en: "How much is it?", uz: "Bu qancha turadi?" },
      { en: "Can I pay by card?", uz: "Karta bilan to'lasam bo'ladimi?" },
      { en: "Thank you, have a nice day!", uz: "Rahmat, kuningiz yaxshi o'tsin!" },
    ],
  },
  {
    id: "meet",
    title: "Tanishuv",
    emoji: "👋",
    level: "A2",
    role: "a new classmate sitting next to the student on the first day of an English course",
    situation: "Two people meet for the first time and make small talk.",
    opener: "Oh, hello! I'm new here. Is anyone sitting here?",
    openerUz: "Oh, salom! Men bu yerda yangiman. Bu yerda kimdir o'tiribdimi?",
    phrases: [
      { en: "Hi, is this seat taken?", uz: "Salom, bu joy bandmi?" },
      { en: "Nice to meet you.", uz: "Tanishganimdan xursandman." },
      { en: "Where are you from?", uz: "Qayerdansiz?" },
      { en: "What do you do?", uz: "Nima ish qilasiz?" },
      { en: "How long have you been learning English?", uz: "Qancha vaqtdan beri ingliz tilini o'rganyapsiz?" },
      { en: "See you later!", uz: "Keyinroq ko'rishguncha!" },
    ],
  },
  {
    id: "airport",
    title: "Aeroportda",
    emoji: "✈️",
    level: "B1",
    role: "an airline check-in agent at an international airport",
    situation: "The student is checking in for a flight to London.",
    opener: "Good morning! Where are you flying to today?",
    openerUz: "Xayrli tong! Bugun qayerga uchyapsiz?",
    phrases: [
      { en: "I'd like to check in for my flight.", uz: "Reysimga ro'yxatdan o'tmoqchiman." },
      { en: "Here is my passport.", uz: "Mana pasportim." },
      { en: "Can I have a window seat?", uz: "Deraza yonidagi joyni bera olasizmi?" },
      { en: "How many bags can I take?", uz: "Nechta sumka olsam bo'ladi?" },
      { en: "Which gate do I go to?", uz: "Qaysi chiqish joyiga borishim kerak?" },
      { en: "Is the flight on time?", uz: "Reys o'z vaqtidami?" },
    ],
  },
  {
    id: "shop",
    title: "Do'konda",
    emoji: "🛍️",
    level: "A2",
    role: "a helpful shop assistant in a clothes store",
    situation: "The student is looking for a jacket.",
    opener: "Hello! Are you looking for anything in particular?",
    openerUz: "Salom! Biror narsa qidiryapsizmi?",
    phrases: [
      { en: "I'm looking for a jacket.", uz: "Men kurtka qidiryapman." },
      { en: "Do you have this in a bigger size?", uz: "Buning kattaroq o'lchami bormi?" },
      { en: "Can I try it on?", uz: "Kiyib ko'rsam bo'ladimi?" },
      { en: "Do you have it in black?", uz: "Qora rangdagisi bormi?" },
      { en: "Is there a discount?", uz: "Chegirma bormi?" },
      { en: "I'll take it.", uz: "Shuni olaman." },
    ],
  },
  {
    id: "directions",
    title: "Yo'l so'rash",
    emoji: "🗺️",
    level: "A2",
    role: "a local person on a city street",
    situation: "The student is a tourist who is lost and asks for directions.",
    opener: "Hi! You look a little lost. Can I help you?",
    openerUz: "Salom! Adashib qolganga o'xshaysiz. Yordam bera olamanmi?",
    phrases: [
      { en: "Excuse me, can you help me?", uz: "Kechirasiz, yordam bera olasizmi?" },
      { en: "How do I get to the train station?", uz: "Vokzalga qanday borsam bo'ladi?" },
      { en: "Is it far from here?", uz: "Bu yerdan uzoqmi?" },
      { en: "Can I walk there?", uz: "U yerga piyoda borsam bo'ladimi?" },
      { en: "Should I turn left or right?", uz: "Chapga burilaymi yoki o'ngga?" },
      { en: "Thanks a lot for your help!", uz: "Yordamingiz uchun katta rahmat!" },
    ],
  },
  {
    id: "interview",
    title: "Universitet suhbati",
    emoji: "🎓",
    level: "B1",
    role: "a university admissions officer conducting a short entrance interview",
    situation: "The student is applying to study at a university.",
    opener: "Good afternoon, please have a seat. Could you tell me a little about yourself?",
    openerUz: "Xayrli kun, o'tiring. O'zingiz haqingizda biroz gapirib bera olasizmi?",
    phrases: [
      { en: "My name is ... and I'm from ...", uz: "Mening ismim ... va men ...danman." },
      { en: "I want to study at this university because ...", uz: "Men bu universitetda o'qimoqchiman, chunki ..." },
      { en: "My favourite subject is ...", uz: "Mening sevimli fanim ..." },
      { en: "In my free time, I like to ...", uz: "Bo'sh vaqtimda men ... yoqtiraman." },
      { en: "My goal is to become a ...", uz: "Mening maqsadim ... bo'lish." },
      { en: "Thank you for your time.", uz: "Vaqtingiz uchun rahmat." },
    ],
  },
];

// 💬 Erkin suhbat: Sado istalgan mavzuda o'zbekcha va inglizcha gaplashadi (iboralar ro'yxatisiz)
export const FREE_LESSON = {
  id: "free",
  free: true,
  title: "Erkin suhbat",
  emoji: "💬",
  level: "A1-C1",
  role: "a smart, friendly bilingual (Uzbek and English) companion and English teacher",
  situation: "Free conversation about anything the student wants.",
  opener: "Assalomu alaykum! Men Sado. Men bilan o'zbekcha ham, inglizcha ham gaplashishingiz mumkin. Bugun nima haqida gaplashamiz?",
  openerUz: "",
  phrases: [],
};

export function getLesson(id) {
  return id === FREE_LESSON.id ? FREE_LESSON : LESSONS.find((l) => l.id === id);
}

// Frontendga yuboriladigan qisqa ko'rinish (AI rol tavsifisiz)
export function publicLesson(l) {
  return {
    id: l.id,
    title: l.title,
    emoji: l.emoji,
    level: l.level,
    phrases: l.phrases,
    ...(l.free ? { free: true } : {}),
  };
}
