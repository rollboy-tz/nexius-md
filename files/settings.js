import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
console.log(process.version);

// Get current file directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const pkgPath = path.join(__dirname, "../package.json");
const pkgData = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));

console.log("Project version:", pkgData.version);
const version = pkgData.version + ' Beta'; //This is beta version


const prefixes = ['.', '$', '/', '%', '+', '>', '~', '&', '!', ',', '-', '_'];
export default {
    //premiun number
    ownerNumber : "255787885020",
    botNumber: "255666961869",
    version: version,
    defaultSettings: {
        muteMode: false, //Mute mode default is off mob activated not muted
        mode: "public", // private, public, admin
        allowedAdminControl: false, // allow admins to change mode
        botReply: true, //Bot will reply to command message
        antPreffixBot: true, //Remove prefixes bot
        langMode: "en",

        //Group setings
        features: {
            warn: true,
            antPreffixBot: true, //Remove prefixes bot
            warnings: {}, //Store all warnings
            warningLimit: 3,
            spamStartLength: 80,
            cacheTime: 1,
            antLink: true, //No link needed in group
            antDelete: false, //Show deleted msg
            antViewOnce: false, //No view once
            antiFake: false, // No Fake number needed fake number can't contain country code
            antSpam: true, // No spam msg repeating message
            antForeign: false, // No foreignnamba neede only(+255 xxxxxxx) wlii be allowed
            tagAll: true, // allow @all tagging
            autoReply: true, // allow auto-reply in groups
            ping: true, // allow ping command
            joke: true, // allow joke command
            moderation: false
        },

        botBehavior: {
            wellComeMessage: false,
            goodbyMessage: false,
            autoReact: false,
        }
    },
    preFixes: prefixes, //Export preffixes too
    
}