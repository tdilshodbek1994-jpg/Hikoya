# DTM botga qo'shiladigan kod (pyTelegramBotAPI / telebot).
from telebot import types

WEBAPP_URL = "https://SIZNING-DOMEN.uz/speaking/"


def register_speaking(bot):
    @bot.message_handler(commands=["speaking"])
    @bot.message_handler(func=lambda m: m.text == "🎤 Speaking")
    def open_speaking(message):
        kb = types.InlineKeyboardMarkup()
        kb.add(types.InlineKeyboardButton(
            "🎤 Speaking mashqi", web_app=types.WebAppInfo(WEBAPP_URL)))
        bot.send_message(
            message.chat.id,
            "🎤 Sado bilan ingliz tilida gaplashing!\n"
            "Vaziyatni tanlang va AI bilan ovoz chiqarib mashq qiling.",
            reply_markup=kb,
        )

# bot.py ichida:  register_speaking(bot)
