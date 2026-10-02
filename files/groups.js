import { groups, saveGroups } from "./autoSyncGroup.js";
import settings from "./settings.js";
import { addMember, removeMember, deleteMessage, setOnlyAdmins, giveWarning, isRepeatedSpam} from "./group_control.js";
import { delay } from "@whiskeysockets/baileys";

function cleanWhite(txt) {
    return txt.replace(/^\s+/gm, '');
}
// ---------- GET GROUPS LISTS AND THEIR SETTING FROM FILE ------------
const botPhone =  settings.botNumber + "@s.whatsapp.net";
function isPremium(sender) {
    return true;
}

const trackedMessage = new Map();

// Remove colon suffix (:1) from JID
function cleanJid(jid) {
    if (!jid) return jid;
    return jid.split(":")[0];
}

// ---------------- GROUP HANDLER ----------------
export default function startGroupHandler(sock) {
    sock.ev.on("messages.upsert", async ({ messages }) => {
        try{
            const msg = messages[0];
            if (!msg) return;
            
            const groupId = msg.key.remoteJid;
            if (!groupId.endsWith("@g.us")) return; // sio group, ignore
            const groupSettings = groups[groupId] || settings.defaultSettings;
            const rep = groupSettings.botReply; //Cheki if bot in reply mode on not this help bot to reply in command message or not
            const langMode = groupSettings.langMode || settings.defaultSettings.langMode; //Language mode default is en
            const pingStart = Date.now(); //This help to measure bot respondig time so ping time will start calurating from here


            const groupCache = {}; //Store group data avoiding mult request
            async function getGroupMetadata(sock, groupId) {
                if(groupCache[groupId] && (Date.now() - groupCache[groupId].time < 6000)) { //If group data found chek if is not expired
                    return groupCache[groupId].data; //If group data not expired use it
                }
           
                    const data = await sock.groupMetadata(groupId); //If group data expired get new one
                    groupCache[groupId] = {data, time: Date.now() }; //Store new data in group cache
                    return data; //Return this new data
            }
            const groupMeta = await getGroupMetadata(sock, groupId); //Get a group data from group caches
            const sentMsg = ( msg.message?.conversation || msg.message?.extendedTextMessage?.text ||msg.message?.imageMessage?.caption || "").trim().toLowerCase();

            // *---------------- BOT IDS ----------------*
            const botLid = '98097707413683@lid'; //Bot id in group
            const botJid = cleanJid(sock.user.id);
            const ownerJid = settings.owneNumber + "@s.whatsapp.net"; // optional

            //Message sender some member sent password in group
            const sender = await cleanJid(msg.key.participantAlt || msg.key.participant || botJid);
            if(sender === botJid) return; //Return if message from bot

            const botIsAdmin = groupMeta.participants.find(p => p.phoneNumber === botJid || p.phoneNumber.split("@")[0] === botJid.split("@")[0])?.admin;
            const senderAdmin = groupMeta.participants.find(p => p.phoneNumber === sender || p.phoneNumber.split("@")[0] === sender.split("@")[0])?.admin;
            const isSuperAmin = senderAdmin === "superadmin";



            //----THIS FUNCTION HELP BOT EITHER BY QUOTING COMMAND MESAGE OR SENDIG NORMAL-----
            //This function has two condition checking in sw language mode mode and en language mode
            // sw => Swahili language
            // en => English langauge
            console.log('Message in', groupMeta.subject, 'from', sender.split('@')[0], ':', sentMsg);
            async function reply(response_en, response_sw) {
                try {
                    console.log("🔁Replying....")
                    if (langMode === "sw") {
                        if (rep) {
                            await sock.sendMessage(groupId, { text: response_sw }, { quoted: msg });
                        } else {
                            await sock.sendMessage(groupId, { text: response_sw });
                        }
                    } else {
                        if (rep) {
                            await sock.sendMessage(groupId, { text: response_en }, { quoted: msg });
                        } else {
                            await sock.sendMessage(groupId, { text: response_en });
                        }
                    }
                    
                    if (!langMode) {
                        console.log("Unknown language mode, default to English");
                    }
                } catch (e) {
                    console.log("Error while replying: ", e)
                }
            }

            async function deleteAsAdmin(massage) {
                if (botIsAdmin) {
                    await delay(3000);
                    await sock.sendMessage(groupId, { delete: massage.key });
                }
            }
        
            // -------------- SAVE MSG TO DB ----------------------------------------
            if(sentMsg.includes("off") || sentMsg.includes("on") && sender === botLid) {
                const owner = settings.owneNumber + "@s.whatsapp.net";
                if(sentMsg.trim() === "off"){
                    const texts = `Bot muted🔇 in Group ${groups[groupId]?.subject || groupId}`;
                    //If in group said off mute moe set on Deactivate bot
                    groupSettings.muteMode = true;
                    groups[groupId] = groupSettings;
                    await sock.sendMessage(groupId, {react: {text: "🔇", key: msg.key}});
                    await sock.sendMessage(owner, {text: texts});
                    return;
                }

                if(sentMsg.trim() === "on"){
                    const texts = `Bot unmuted🔊 in Group ${groups[groupId]?.subject || groupId}`;
                    const response = "_*ROLLBOY BOT🤖*_\n✅Is now unmuted in this group🔊";
                    //If in group said on mute ode set off Aloow activate bot
                    groupSettings.muteMode = false;
                    groups[groupId] = groupSettings;
                    await sock.sendMessage(groupId, {text: response});
                    await sock.sendMessage(groupId, {react: {text: "🔊", key: msg.key}});
                    await sock.sendMessage(owner, {text: texts});
                    return;
                }
            }
            //Check if bot is muted or unmuted
            if (groupSettings.muteMode) return;
        
            //================================= Here we start cheking all un authorized process =======================================
            //--------------------------------ANT LINK ACTION ----------------------
            if(groupSettings.features.antLink && sentMsg.toLowerCase().includes("https://") || sentMsg.toLowerCase().includes("http://")) {
                const type = "link";
                const reason = " 🔗 Link sharing isn`t allowed in this group.\n 🤷‍♂️ Woever sends link  will be punished 🔨";
            
                giveWarning(sock, groupId, sender, type, reason, botIsAdmin, msg, groupSettings);
                deleteAsAdmin(msg);
                return;
            }

            //---------------------- ANT OREFFIX BOT ------------------------------------------------------------
            //Load preffixes.
            const preFixes = settings.preFixes;
            //Check if message start with prefixes
            const hasPreffix = preFixes.some(prefix => sentMsg.trim().startsWith(prefix));
            const antBot = groupSettings.antPreffixBot || settings.defaultSettings.antPreffixBot;

            /initiate condition checking...
            if(antBot && hasPreffix) {
                const msgId = msg.key.id;
                if(!trackedMessage.has(groupId)) trackedMessage.set(groupId, new Set());
                trackedMessage.get(groupId).add(msgId);
            }

            const replied = msg.message?.extendedTextMessage?.contextInfo;
            if (replied && replied.stanzaId) {
                const repliedMsgId = replied.stanzaId;
                if (trackedMessage.has(groupId) && trackedMessage.get(groupId).has(repliedMsgId)) {
                    const type = "bot";
                    const reason = ` ⚠ You responded to message considered as a bot 🤖 command. \n🤨 🚫 Those bots are not allowed in this group!`;
                    giveWarning(sock, groupId, sender, type, reason, botIsAdmin, msg, groupSettings)
                }
            }


            const antSpam = groupSettings.features.antSpam || settings.defaultSettings.features.antSpam;
            const limit = groupSettings.features.spamStartLength || settings.defaultSettings.features.spamStartLength;
            if (antSpam && sentMsg.length > limit) {
                const time = (groupSettings.features.cacheTime ?? settings.defaultSettings.features.cacheTime);
                const cacheTime = time * 3600000;
                const spam = isRepeatedSpam(groupId, sender, sentMsg, cacheTime);
                const type = "spam";
                const desc = `⚠ You sent repeted to send one message in *${time} Hour(s)*.\n 🗯This is known as spam message.`;
                if(spam) {
                    giveWarning(sock, groupId, sender, type, desc, botIsAdmin, msg, groupSettings)
                    deleteAsAdmin(msg);
                    return;
                }
            }

            // ---------------- MENTIONS ----------------
            const mentions = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
            const isBotMentioned = mentions.includes(botLid);// ||normalizedMentions.includes(ownerJid);

            const mentionedJids = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
            let targetUser = undefined;
            if  (mentionedJids.length > 0) {
                targetUser = mentionedJids[1] || undefined; // mtu wa kwanza aliye-tagwa
            }

            if (!targetUser && msg.message?.extendedTextMessage?.contextInfo?.participant) {
                  targetUser = msg.message.extendedTextMessage.contextInfo.participant || undefined;;
            }


            // *---------------- DEBUG ----------------
            //console.log("📩 New group message");
            // console.log("🔹 Group ID:", groupId);
            //console.log("🤖 Bot ID:", botJid);
            //console.log("👥 Mentions:", mentions);
             //console.log("🔄 Normalized Mentions:", normalizedMentions);
            //console.log("✅ Bot mentioned?", isBotMentioned);
            //console.log("🗨  Messeji info: ", msg)


            if (!isBotMentioned) return; // *bot hajatajwa

            // ----------------SUNITIZING MESSAGE TO TEXT ----------------
            //Remove bot number in mention message and multiple trim make sure no whitespace
            //Fist trim, Cgange it to lowercase
            const sentText = sentMsg.trim(); //Second trim
            const textParts = sentText.split(" "); //Split message into parts
            const textToTrim = textParts.slice(1).join(" ").trim(); //Rejoin after removing bot id number then Third trim
            const text = textToTrim.trim(); // Farth trim. I used multriple trim to help beginner is so hard to understand legance

            // -------------------------------------- PROCESSING COMAND AND DO ACTION RETURN RESPONSES ---------------------------------------------
            // ----- PREMIUM USERS ACCESS -------
            // ----- By default bot is in private mode in group so only premium user can set either admins mode or public...., Admin can turn to Or to decide Admins to do it
            if (isPremium(sender)) {
                if (text.includes("setadmin") || text.includes("admin mode") || text.includes("admins mode") || text.includes("mode to admin") || text.includes("mode to admins")) {
                    groupSettings.mode = "admin";
                    groups[groupId] = groupSettings;
                    saveGroups();
                    const response_en = "✅ Bot Privacy Mode changed to admins by bot owner.\nNow admin`s can use bot in this group";
                    const response_sw = "✅ Hali ya faragha ya bot imebadilishwa na mmiliki.\nSasa hivi viongozi wa kikundi wanaweza kutumi bot"
                    reply(response_en, response_sw);
                    return;
                }

                if (text.includes("setprivate") || text.includes("private mode") || text.includes("private mode") || text.includes("mode to private") || text.includes("mode to private")) {
                    groupSettings.mode = "private";
                   groups[groupId] = groupSettings;
                   saveGroups();
                   const response_en = "✅ Bot Privacy Mode changed to private mode by Bot Owner.\nOnly Bot owner can use the bot now.";
                   const response_sw = "✅ Hali ya faragha ya bot imebadilishwa kuwa ya kibinafsi na mmiliki.\nNi mmiliki ndo anaweza kutumia bot hii.";
                    reply(response_en, response_sw);
                   return;
                }

                if (text.includes("setpublic") || text.includes("public node") || text.includes("public mode") || text.includes("mode to public") || text.includes("allow members")) {
                    groupSettings.mode = "public";
                   groups[groupId] = groupSettings;
                   saveGroups();
                   const response_en = "✅ Bot Mode changed to public mode by Bot Owner.\nAny one in this group can use this bot\nLets enjoy...👌";
                   const response_sw = "✅ Hali ya faragha ya boyi imebadilishwa kuwa hadharani.\nSasa kila moja kwenye hili group anaweza kutumia bot\nHaya tufurahieni...👌"
                   reply(response_en, response_sw);
                   return;
                } 
            
                if (text.includes("allow-admin-control") || text.includes("allow admins to control") || text.includes("admins control")) {
                   groupSettings.allowAdminControl = true;
                   groups[groupId] = groupSettings;
                    saveGroups();
                    const response_en = "✅ Bot Admin control activated for this Group. Now admins of this group can change the bot privacy mode";
                    const response_sw = "✅ Udhibiti wa bot kwa admin umewezeshwa. Sasa wasimamizi wa group hili wanaweza kubadilisha hali ya faragha ya bot";
                    reply(response_en, response_sw);
                    return;
                } 
            
                if (text.includes("disallow-admin-control") || text.includes("disallow admin to controll") || text.includes("dont allow admins to control") || text.includes("remove admins control")) {
                   groupSettings.allowAdminControl = false;
                    groups[groupId] = groupSettings;
                    saveGroups();
                    const response_en =  "✅ Admin control deactivated for this group by Bot Owner. Now admins can`t change the bot privacy mode";
                    const response_sw =  "✅ Udhibiti wa admin umezimwa na mmiliki wa bot. Kuanzia sasa viongozi wa group hawataweza kubadilisha hali ya faragha ya bot";
                    reply(response_en, response_sw);
                    return;
                }

                //For debug popose only
                if (text.includes("showmetadata") || text.includes("metadata")) {
                   await sock.sendMessage(sender, { text: JSON.stringify(groupMeta, null, 2) });
                   const response = "✅ Group metadata sent to your inbox boss.";
                    await sock.sendMessage(groupId, { text: response }, { quoted: msg })
                   return;
                }

                if (text.includes("off reply") || text.includes("reply off") || text.includes("repoff") || text.includes("usijibu ujumbe")) {
                    groupSettings.botReply = false;
                    groups[groupId] = groupSettings;
                    saveGroups();
                    console.log("Line 280 text: ", text)
                    const response_en = "*Repply mode deactivates ❎*\n From now i can't reply  direct to coammand messages except to some special messages";
                    const response_sw = "*Hali ya kujibu ujumbe imezimwa ❎*\nKuanzia sasa sitjibu moja kwa moja kwenye jumbe zenye amri isipokuwa kwa baadhi ya jumbe maalumu.";
                    reply(response_en, response_sw);
                    return;
                }
                
                if (text.includes("on reply") || text.includes("reply to") || text.includes("reply on") || text.includes("repon") || text.includes("jibu ujumbe") || text.includes("jibu kwenye ujumbe")) {
                    groupSettings.botReply = true;
                    groups[groupId] = groupSettings;
                    saveGroups();
                    const response_en = "*Reply to massage setting activated ✅*\n Now I will reply to Commanded messages direct except to some messages";
                    const response_sw = "*Hali ya kujibu ujumbe imewezeshwa ✅*\n Sasa nitajibu moja kwa moja ujumbe wenye amri isipokuwa baadhi ya jumbe";
                    reply(response_en, response_sw);
                    return;
                }

                if (text.includes("to swahili") || text.includes("swahili mode") || text.includes("tumia kiswahili") || text.includes("use swahili") || text.includes("lang-sw") || text.includes("usitumie kiingereza") || text.includes("usijibu kwa kiingereza")){
                    groupSettings.langMode = "sw";
                    groups[groupId] = groupSettings;
                    const response_sw = "🌍 Hali ya lugha imebadilishwa kwenda Kiswahili\nsasa nitajibu kwa kiingereza.";
                    const response_en = "🌍 Language mode changed to Swahili\n 🤖 Now will respond in swahili";
                    reply(response_en, response_sw)
                    return;
                }

                if (text.includes("to english") || text.includes("english mode") || text.includes("tumia kiingereza") || text.includes("use english") || text.includes("lang-en") || text.includes("tumia english") || text.includes("do not use swahili") || text.includes("don`t use swahili") || text.includes("jibu kwa kiswahili")){
                    groupSettings.langMode = "en";
                    groups[groupId] = groupSettings;
                    const response_en = "🌎 Language mode changed to English\n 🤖 A Bot will respond in english Even if it undestands of swahili language.";
                    const response_sw = "🌍 Hali ya lugha imebadilishwa kwenda Kiswahili\n Bot sasa itajibu kwa kiiingereza ingawa itaelewa mfulizo wote wa amri hata za kiswahili.";
                    reply(response_en, response_sw);
                    return;
                }
            }

            const adminControlStstus = groupSettings.allowAdminControl ? "yes" : "no";
            if (adminControlStstus === "yes" && msg.key.fromMe === false) {
                if (senderAdmin || isSuperAmin) {
                    //Admin can change mode to private... But when bot is in private mode even him cant, change it except premium user
                   if (text.includes("setprivate") || text.includes("private mode") || text.includes("private mode") || text.includes("mode to private") || text.includes("mode to private")) {
                        groupSettings.mode = "private";
                       groups[groupId] = groupSettings;
                       saveGroups();
                       const response = "✅Bot Mode imebadilishwa changed to private by Group Admin";
                      reply(response);
                        return;
                    }
            
                    if (text.includes("setadmin") || text.includes("admin mode") || text.includes("admins mode") || text.includes("mode to admin") || text.includes("mode to admins")) {
                        groupSettings.mode = "admin";
                        groups[groupId] = groupSettings;
                        saveGroups();
                        const response = "✅Bot Mode imebadilishwa to admins by Group admin";
                        reply(response);
                        return;
                    }

                    if (text.includes("setpublic") || text.includes("public node") || text.includes("public mode") || text.includes("mode to public") || text.includes("allow members")) {
                       groupSettings.mode = "public";
                       groups[groupId] = groupSettings;
                       saveGroups();
                       const response = "✅ Bot Mode changed to public mode by Group Admin.\nAny one in this group can use this bot\nLets enjoy...";
                       reply(response);
                       return;

                    }
                }

            }

            console.log("Message")
            if (senderAdmin || isSuperAmin && msg.key.fromMe === false && groupSettings.mode !== "private") {
               //Admins activity
                if (text.startsWith("delete") || text.startsWith("futa")) {
                    await deleteMessage(sock, groupId, msg, botIsAdmin);
                   return;
                }

                if (text.includes("admin only") || text.includes("only admin") || text.includes("funga") || text.includes("ufunge") || text.includes("only") || text.includes("close") || text.includes("admin pekee") || text.includes("admin ndo tu")) {
                    await setOnlyAdmins(sock, groupId, true, botIsAdmin);
                    return;
                }  

                if (text.includes("allow members send") || text.includes("every can") || text.includes("open") || text.includes("fungua") || text.includes("ufungue") || text.includes("all member to send") || text.includes("all members sending")) {
                    await setOnlyAdmins(sock, groupId, false, botJid);
                    return;
                }

                if (text.includes("ondoa") || text.includes("remove") || text.trim().startsWith("muondoe") || text.includes("mtoe")) {
                   let memberId = text.split(" ")[1].replace(/[^0-9]/g, "") + "@lid"; // Extract member ID
                    if (!memberId || memberId === "@s.whatsapp.net") {

                        if (msg.message?.extendedTextMessage?.contextInfo?.participant) {
                           memberId = msg.message.extendedTextMessage.contextInfo.participant;
                        }
                    }

                    const response = await removeMember(sock, groupId, memberId, senderAdmin, botIsAdmin, msg);
                    reply(response);
                    return;
                }

                if (text.includes("off reply") || text.includes("reply off") || text.includes("repoff") || text.includes("don't reply") || text.includes("do not reply") || text.includes("usijibu") || text.includes("acha kujibu")) {
                    groupSettings.botReply = false;
                    groups[groupId] = groupSettings;
                    saveGroups();
                    const response_en = "*Repply mode deactivates ❎*\n From now i can't reply  direct to coammand messages except to some special messages";
                    const response_sw = "*Hali ya kujibu ujumbe imezimwa ❎*\nKuanzia sasa sitjibu moja kwa moja kwenye jumbe zenye amri isipokuwa kwa baadhi ya jumbe maalumu.";
                    reply(response_en, response_sw);
                } 
                
                if (text.includes("on reply") || text.includes("reply to") || text.includes("reply on") || text.includes("repon")) {
                    groupSettings.botReply = true;
                    groups[groupId] = groupSettings;
                    onslotchange.log("Line 394: ", text)
                    saveGroups();
                    const response_en = "*Reply to massage setting activated ✅*\n Now I will reply to Commanded messages direct except to some messages";
                    const response_sw = "*Hali ya kujibu ujumbe imewezeshwa ✅*\n Sasa nitajibu moja kwa moja ujumbe wenye amri isipokuwa baadhi ya jumbe";
                    reply(response_en, response_sw);
                   return;
                }

                if (text.includes("antlink-on") || text.includes("on ant link") || text.includes("ant link on")) {
                    groupSettings.features.antLink = true;
                    groups[groupId] = groupSettings;
                    saveGroups();
                    const response = "*🚫🔗Ant-Link:  _Activated_* ✅\n\n🔗 ```Links sharing is not allowed in this group.```\n\n> ⚠ Whoever sends link will be removed from the group 🔗\n\n📢Procedure should be followed"
                    reply(response);
                    return;
                }

                if (text.includes("antlink-off") || text.includes("off ant link") || text.includes("ant link off")) {
                    groupSettings.features.antLink = false;
                    groups[groupId] = groupSettings;
                    saveGroups();
                    const response = "*🚫🔗Ant-Link: _Disctivated_* ❎\n\n👤 ```Any member can share a link 🔗 in this group.```\n\n> ⚠ Link should not go against to the group procedure 🔗\n\n📢 *Procedure should be followed*"
                    reply(response);
                    return;
                }
            }

            // NON-PREMIUM USERS OR NON-ADMINS
            if (groupSettings.mode === "public" || (groupSettings.mode === "admin" && msg.key.fromMe === false) || senderAdmin || isPremium(sender)) {
                // Public mode - anyone can use
                if (text.startsWith("addmember") || text.startsWith("ongeza") || text.startsWith("add") || text.startsWith("ongeza member") || text.startsWith("ongeza mtu") || text.startsWith("add member") || text.startsWith("add mtu huyu")) {
                    const memberId = text.split(" ")[1].replace(/[^0-9]/g, "") + "@s.whatsapp.net"; // Extract member ID
                    const statusCode = await addMember(sock, groupId, memberId, senderAdmin, botIsAdmin, groupMeta);
                    if(statusCode === 1 || statusCode === 2) {
                        reply(`✅Member ${memberId} added successfully!`);
                    }

                    if (statusCode === 3 ) {
                        reply("❎Cant add member roght now!. Please make bot as admin to handle this action.");
                    }

                    if (statusCode === 4) {
                        reply(`❎I can't add this member right Now!. Only admin can add member!`);
                    }

                    if (statusCode === 5) {
                        reply("Err when adding member")
                    }
                    //reply(response);
                    return;
                }

                //Show group info but not member list by length number of members and admins length only
                if (text.includes("groupinfo") || text.includes("group info") || text.includes("info for this group") || text.includes("info ya group")) {
                    const memberCount = groupMeta.participants.length;
                    const adminCount = groupMeta.participants.filter(p => p.admin !== undefined).length;
                    const response = `📋 *Group Info*\n\n🆎 *Name:* ${groupMeta.subject}\n👑 *Admins:* ${adminCount}\n👥 *Members:* ${memberCount}\n\n*Bot settings🛠 in group:*\n⚙️ *Mode:* ${groupSettings.mode}\n🔧 *Admin Control Allowed:* ${groupSettings.allowAdminControl ? "Yes" : "No"}`;
                    reply(response);
                    return;
                }

                //Show group owner or creator info
                if (text.includes("group owner") || text.includes("group creator") || text.includes("owner info")) {
                    const owner = groupMeta.participants.find(p => p.admin === "superadmin");
                    const response = owner ? `👑 *Group Owner Info*\n\n🆔 *ID:* ${owner.id.split("@")[0]}\n📞 *Number:* +${owner.phoneNumber.split("@")[0]}` : "❌ Group owner not found.";
                    reply(response);
                    return;
                }

                if (text.includes("whoadmins") || text.includes("list admins") || text.includes("admins contacts")) {
                   const adminList = groupMeta.participants.filter(p => p.admin !== null) // chukua admins
                   .map(p => {
                    let number = "+" + p.phoneNumber.split("@")[0]; // convert JID to phone number
                    return `👑 ${number}`;
                    }).join("\n") || "No admins found.";
                   const response = `📋 *Admin(s) Contacts*\n\n${adminList}`;
                   reply(response);
                    return;
                }

                // --- taging commamds ---
                if (text.includes("tagall") || text.includes("tag all") || text.includes("everyone") || text.includes("wote")) {
                    const allJids = groupMeta.participants.map(p => p.id);
                    const response = `📢 *Hi @everyone*\n\Keep yor atentionn her. _You are tagged by:_\n> +${sender.split("@")[0]}`;
                    reply(response);
                    return;
                }

                if (text.startsWith("post") || text.startsWith("hide tag") || text.startsWith("hidetag")) {
                    const parts = text.split(" ");
                    const argument = parts.slice(1).join(" ");
                    const allJids = groupMeta.participants.map(p => p.id);
                    const response = `*+${sender.split("@")[0]}*\n📢Posted A Message💭\n\n*💬Content:*\n${argument}`;
                    await sock.sendMessage(groupId, { text: response, mentions: allJids });
                    console.error("Error when sending a mesaage: ", e)
                
                    return;
                }
            
                //Show bot info
                if (text.includes("botinfo") || text.includes("bot info") || text.includes("info for bot") || text.includes("bot description") || text.includes("your info")) {
                    let langauge = "English";
                    if (langMode === "sw") {
                        langauge = "Swahili";
                    }
                    const txt = `
                    *╭──·๏〔  _ROLLBOY-BOT MD_  〕◉*
                    *├◈ ✨* Version: *${settings.version}*
                    *├◈ 👤*  User: *${msg.pushName || '+' + msg.phoneNumber.split("@")[0]}*
                    *├◈ 🌍*  Language Mode: *${langauge}*
                    *├◈ ⚙️*  Privacy Mode: *${groupSettings.mode}*
                    *├◈ 🔧*  Admin(s) control: *${groupSettings.allowAdminControl ? "Allowed" : "Not-Allowed"}*
                    *├◈ 💬*  Reply to message: *${rep ? "On" : "Off"}*
                    *╰──────────────────◉*
                    > .
                    *╭──·๏〔  _GROUP FEATURES_  〕◉*
                    *├◈ 🔗*  Ant-Link: *${groupSettings.features.antLink ? "On" : "Off"}*
                    *├◈ 🤖*  Ant-Preffix Bot: *${groupSettings.features.antPreffixBot ? "On" : "Off"}*
                    *├◈ 🗯*  Ant-Spam message: *${groupSettings.features.antSpam ? "On" : "Off"}*
                    *├◈ 🚫*  Warn First: *${groupSettings.features.warn ? "On" : "Off"}*
                    *├◈ ⚠*  Warning Limit: *${groupSettings.features.warningLimit}*
                    *╰──────────────────◉*
                    > .
                    *╭───·๏〔  _BOT DEVELOPER_  〕◉*
                    *├◈ 👨🏿‍💻* Name: *Rollboy TZ*
                    *├◈ 🌟* Built For: *Rollboy Services*
                    *├◈ 💻* Tech Start-up: *Rollboy Tech*
                    *╰──────────────────◉*`;
                    const response = cleanWhite(txt);
                    reply(response, response);
                   return;
                }

                //Show bot owner info bot owner is premium user
                if (text.includes("bot owner") || text.includes("bot creator") || text.includes("owner info") || text.includes("botowner")) {
                    const response = `👑 *Bot Owner Info*\n\n🆎 *Name:* Rollboy TZ\n📞 *Number:* +${settings.owneNumber}\n🌐 *Email:* rollboyervices@yahoo.com\n\n*Contact the owner for more info.*`;
                    reply(response, response);
                    return;
                }

                /*/Show mow time
                if (text.includes("time")) {
                   const now = new Date();
                   const response = `🕒 *Current Time*\n\n📅 *Date:* ${now.toLocaleDateString()}\n🕰️ *Time:* ${now.toLocaleTimeString()}`;
                   reply(response);
                    return;
                }

                */
                //Other funy commands
                if (text.trim() === "hello" || text.trim() === "hi" || text.trim() === "hey" || text.trim() === "hellow") {
                    const response_en = "👋 Hello! We are allways togather \nWatching💬 messages if there any command included...";
                    const response_sw = "👋 Habari! Tuko pamoja\nNaangalia mazungumzo yenu kama kuna amri yeyote ndani yake..."
                    reply(response_en, response_sw);
                    return;
                }

                //Bot interact other embers in their inboxes fromm group
                if (text.includes("inbox") || text.startsWith("text me") || text.includes("huduma")) {
                    await sock.sendMessage(sender, { text: `👋 Hellow! Mimi ni ROLLBOY BOT🤖. Ni whatsApp chatBot🗨 kutoka *Rollboy Services* nimekuja inbox sasa andika *Habari*.\nKuanza mazungumzo au andika *Msaada* kupata maelekezo.\nUnaweza kuwasiliana na mtoa huduma moja kwa moja kwa namba:\n📞+255 787 885 020\n\n_Ahsante😎_` });
                    await sock.sendMessage(groupId, { text: "Angalia👀 inbox yako nimetuma ujumbe boss🙂"}, { quoted: msg });
                    console.error("Error when sending a massege: ", e)
                    return;
                }

                //Joke
                /*
                if (text.includes("dice") || text.includes("roll")) {
                    const roll = Math.floor(Math.random() * 9) + 1;
                    const response = `🎲 You rolled a ${roll}`;
                    reply(response, response);
                    return;
                }

                if (text.includes("coin")) {
                    const toss = Math.random() < 0.5 ? "Heads" : "Tails";
                    const response = `🪙 Coin toss: ${toss}`;
                    reply(response, response);
                    return;
                }
                */
                //Ping for ping network
                if (text.includes("ping")) {
                    const latency = Date.now() - pingStart;
                    const response_en = `\n╭──────────────────╮\n│       📶 *PING STATUS*       │\n╰──────────────────╯\n ⏱️ Latency: ${latency}ms`;
                    reply(response_en, response_en);
                    return;
                }

                if (text.includes("menu") || text.includes("help") || text.includes("msaada")) {
                    //Menu list in english mode and swahili mode
                    const english = `
                    \n╭──────────────────╮\n│       📋 *ROLLBOY BOT MENU*       │\n╰──────────────────╯ \n 
                    1. *addmember <number>* - Add member to group\n
                    2. *removemember <number>* - Remove member from group\n
                    3. *groupinfo* - Show group information\n
                    4. *botinfo* - Show bot information\n
                    5. *botowner* - Show bot owner information\n
                    6. *tagall* - Tag all members in the group\n
                    7. *post <message>* - Post a message tagging all members without showing tags\n
                    8. *ping* - Check bot latency\n
                    9. *help* - Show this menu\n
                    10. *inbox* - Get bot to message you in your inbox\n
                    11. *whoadmins* - Show list of group admins\n
                    12. *group owner* - Show group owner information\n
                    13. *setpublic* - Set bot to public mode (anyone can use)\n
                    14. *setprivate* - Set bot to private mode (only owner can use)\n
                    15. *setadmin* - Set bot to admin mode (only admins can use)\n
                    16. *allow-admin-control* - Allow admins to change bot privacy mode\n
                    17. *disallow-admin-control* - Disallow admins from changing bot privacy mode\n
                    18. *on reply* - Activate bot reply to command messages\n
                    19. *off reply* - Deactivate bot reply to command messages\n
                    20. *to swahili* - Set bot response language to Swahili\n
                    21. *to english* - Set bot response language to English\n
                    22. *antlink-on* - Activate anti-link feature in group\n
                    23. *antlink-off* - Deactivate anti-link feature in group\n
                    `
                    const swahili = `
                    \n╭──────────────────╮\n│       📋 *ROLLBOY BOT MENU*       │\n╰──────────────────╯ \n
                    1. *ongeza mwanachama <nambari>* - Ongeza mwanachama kwenye kikundi\n
                    2. *ondoa mwanachama <nambari>* - Ondoa mwanachama kutoka kikundi\n
                    3. *habari za kikundi* - Onyesha habari za kikundi\n
                    4. *habari za bot* - Onyesha habari za bot\n
                    5. *mmiliki wa bot* - Onyesha habari za mmiliki wa bot\n
                    6. *tagall* - Mtaja wanachama wote kwenye kikundi\n
                    7. *post <ujumbe>* - Tuma ujumbe ukitaja wanachama wote bila kuonyesha tag\n
                    8. *ping* - Angalia latency ya bot\n
                    9. *msaada* - Onyesha menyu hii\n
                    10. *inbox* - Pata bot ikutumie ujumbe kwenye inbox yako\n
                    11. *whoadmins* - Onyesha orodha ya wasimamizi wa kikundi\n
                    12. *mmiliki wa kikundi* - Onyesha habari za mmiliki wa kikundi\n
                    13. *setpublic* - Weka bot kwenye mode ya hadharani (kila mtu anaweza kutumia)\n
                    14. *setprivate* - Weka bot kwenye mode ya kibinafsi (mmiliki peke yake anaweza kutumia)\n
                    15. *setadmin* - Weka bot kwenye mode ya admin (wasimamizi peke yao wanaweza kutumia)\n
                    16. *allow-admin-control* - Ruhusu wasimamizi kubadilisha mode ya faragha ya bot\n
                    17. *disallow-admin-control* - Zuia wasimamizi kubadilisha mode ya faragha ya bot\n
                    18. *on reply* - Wezesha bot kujibu jumbe zenye amri\n
                    19. *off reply* - Zima bot kujibu jumbe zenye amri\n
                    20. *to swahili* - Weka lugha ya majibu ya bot kuwa Kiswahili\n
                    21. *to english* - Weka lugha ya majibu ya bot kuwa Kiingereza\n
                    22. *antlink-on* - Wezesha kipengele cha anti-link kwenye kikundi\n
                    23. *antlink-off* - Zima kipengele cha anti-link kwenye kikundi\n
                    `
                    const response_en = cleanWhite(english);
                    const response_sw = cleanWhite(swahili);
                    reply(response_en, response_sw)
                }

                if (text === "") {
                    const response_en = "*Hellow! am still online 🟢* \nWatching your chats👀. \n 👉🏿 Type a command i will respond or i will do it🙂 \n\n> Don`t forget tagging me when you type an command!\n\n Thanks! You are wellcome 🤝";
                    const response_sw = "*Habari! mimi niko online 🟢* \nNaangalia mazungumzo yenu munavochati👀.\n 👉🏿 Andika amri yeyote nitajibu au kufanya jambo🙂\n\n> Usisahau kunitaja mnapoandika amri.\n\n Ahsante!, Karibu sana! 🤝🏿";
                    reply(response_en, response_sw);
                    return;

                } else {
                    //console.log(text)
                    const response_en = "👀No defined command included in messsage...\n🙄Type ```help``` for more info or type ```menu``` to see command list.\n\n> Don`t forget tagging me when you type an command!\n\n Thanks! You are wellcome 🤝";
                    const response_sw = "👀 Hakuna amri iliopo kenye meseji... \n🙄 Andika ```msaada``` kwa maelezo zaini au andika ```menu``` kuona orodha za amri\n\n> Usisahau kunitaja mnapoandika amri.\n\n Ahsante!, Karibu sana! 🤝🏿";
                    reply(response_en, response_sw);
                    return;
                }
            } else {
                await sock.sendMessage(groupId, { react: {text: "👋", key: msg.key} });
                return;
            }
                
        } catch (e) {
            console.error("Error in message upsert: ", e);
        }
    });
}
