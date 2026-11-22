# DTM botga qo'shiladigan kod (aiogram 3.x).
# WEBAPP_URL ni o'z domeningizga almashtiring. Oxiridagi "/" belgisi muhim!
from aiogram import Router, F
from aiogram.filters import Command
from aiogram.types import (
    Message, WebAppInfo,
    InlineKeyboardMarkup, InlineKeyboardButton,
    ReplyKeyboardMarkup, KeyboardButton,
)

WEBAPP_URL = "https://SIZNING-DOMEN.uz/speaking/"

speaking_router = Router()


def speaking_inline_kb() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(inline_keyboard=[[
        InlineKeyboardButton(text="🎤 Speaking mashqi", web_app=WebAppInfo(url=WEBAPP_URL))
    ]])


@speaking_router.message(Command("speaking"))
@speaking_router.message(F.text == "🎤 Speaking")
async def open_speaking(message: Message):
    await message.answer(
        "🎤 <b>Sado bilan ingliz tilida gaplashing!</b>\n\n"
        "Vaziyatni tanlang, AI suhbatdosh bilan ovoz chiqarib gaplashing "
        "va har darsda 6 ta iborani mashq qiling.",
        reply_markup=speaking_inline_kb(),
        parse_mode="HTML",
    )


# Ixtiyoriy: asosiy menyudagi oddiy tugma (reply keyboard).
# Mavjud menyungizga KeyboardButton(text="🎤 Speaking") ni qo'shsangiz kifoya.
main_menu_example = ReplyKeyboardMarkup(
    keyboard=[[KeyboardButton(text="🎤 Speaking")]],
    resize_keyboard=True,
)

# main.py / bot.py ichida:
#     from speaking import speaking_router
#     dp.include_router(speaking_router)
