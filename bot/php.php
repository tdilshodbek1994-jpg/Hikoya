<?php
// DTM bot PHP'da bo'lsa (webhook). $chat_id va $text sizning kodingizdan keladi.
$WEBAPP_URL = "https://SIZNING-DOMEN.uz/speaking/";

if ($text === "/speaking" || $text === "🎤 Speaking") {
    $keyboard = [
        "inline_keyboard" => [[
            ["text" => "🎤 Speaking mashqi", "web_app" => ["url" => $WEBAPP_URL]]
        ]]
    ];
    bot("sendMessage", [
        "chat_id" => $chat_id,
        "text" => "🎤 Sado bilan ingliz tilida gaplashing!\nVaziyatni tanlang va AI bilan ovoz chiqarib mashq qiling.",
        "reply_markup" => json_encode($keyboard),
    ]);
}

// bot() funksiyangiz bo'lmasa:
// function bot($method, $data = []) {
//     $url = "https://api.telegram.org/bot" . BOT_TOKEN . "/" . $method;
//     $ch = curl_init($url);
//     curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
//     curl_setopt($ch, CURLOPT_POSTFIELDS, $data);
//     $res = curl_exec($ch);
//     curl_close($ch);
//     return json_decode($res, true);
// }
