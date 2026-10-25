/* SPDX-License-Identifier: MPL-2.0
 * Roomcast native RTP sender. Uses the C ABI exported by the bundled libdatachannel.
 * ABI declarations follow include/rtc/rtc.h at OBS's pinned libdatachannel
 * commit 9d5c46b8f506943727104d766e5dad0693c5a223 (v0.21.0).
 * No encoder, ICE credentials, or network policy is selected here. */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <wincrypt.h>
#include <stdint.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdarg.h>

typedef struct { const char **iceServers; int iceServersCount; const char *proxyServer,*bindAddress; int certificateType,iceTransportPolicy; bool enableIceTcp,enableIceUdpMux,disableAutoNegotiation,forceMediaTransport; uint16_t portRangeBegin,portRangeEnd; int mtu,maxMessageSize; } Configuration;
typedef struct { int direction,codec,payloadType; uint32_t ssrc; const char *mid,*name,*msid,*trackId,*profile; } TrackInit;
typedef struct { uint32_t ssrc; const char *cname; uint8_t payloadType; uint32_t clockRate; uint16_t sequenceNumber; uint32_t timestamp; uint16_t maxFragmentSize; int nalSeparator,obuPacketization; uint8_t playoutDelayId; uint16_t playoutDelayMin,playoutDelayMax; } PacketizerInit;
typedef void (*DescriptionCb)(int,const char*,const char*,void*);
typedef void (*CandidateCb)(int,const char*,const char*,void*);
typedef void (*StateCb)(int,int,void*);
typedef void (*OpenCb)(int,void*);
typedef void *(*InterceptorCb)(int,const char*,int,void*);
#define API(ret,name,args) static ret (*name) args
API(int,rtcCreatePeerConnection,(const Configuration*));
API(int,rtcDeletePeerConnection,(int)); API(int,rtcClosePeerConnection,(int));
API(void,rtcSetUserPointer,(int,void*));
API(int,rtcSetLocalDescriptionCallback,(int,DescriptionCb));
API(int,rtcSetLocalCandidateCallback,(int,CandidateCb));
API(int,rtcSetStateChangeCallback,(int,StateCb));
API(int,rtcSetOpenCallback,(int,OpenCb));
API(int,rtcSetRemoteDescription,(int,const char*,const char*));
API(int,rtcSetLocalDescription,(int,const char*));
API(int,rtcAddRemoteCandidate,(int,const char*,const char*));
API(int,rtcAddTrackEx,(int,const TrackInit*));
API(int,rtcDeleteTrack,(int));
API(int,rtcSetH264Packetizer,(int,const PacketizerInit*));
API(int,rtcSetOpusPacketizer,(int,const PacketizerInit*));
API(int,rtcChainRtcpSrReporter,(int));
API(int,rtcChainRtcpNackResponder,(int,unsigned));
API(int,rtcChainPliHandler,(int,OpenCb));
API(int,rtcSetTrackRtpTimestamp,(int,uint32_t));
API(int,rtcSetNeedsToSendRtcpSr,(int));
API(int,rtcSendMessage,(int,const char*,int));
API(bool,rtcIsOpen,(int));
API(int,rtcSetMediaInterceptorCallback,(int,InterceptorCb));
API(void*,rtcCreateOpaqueMessage,(void*,int));
API(void,rtcInitLogger,(int,void(*)(int,const char*)));
API(void,rtcCleanup,(void));

typedef struct { volatile LONG active; char id[96]; int pc,video,audio; volatile LONG keyframe; uint64_t lastSr; } Session;
static Session sessions[64];
static CRITICAL_SECTION outputLock;
static void escaped(const char *s) { putchar('"'); for(;*s;s++){ unsigned char c=*s; if(c=='"'||c=='\\'){putchar('\\');putchar(c);} else if(c=='\r') fputs("\\r",stdout); else if(c=='\n') fputs("\\n",stdout); else if(c<32) printf("\\u%04x",c); else putchar(c); } putchar('"'); }
static void eventStart(const char *event,Session *s) { EnterCriticalSection(&outputLock); fputs("{\"event\":",stdout); escaped(event); if(s){fputs(",\"id\":",stdout);escaped(s->id);} }
static void eventEnd(void){ fputs("}\n",stdout); fflush(stdout); LeaveCriticalSection(&outputLock); }
static void errorEvent(Session*s,const char *reason){eventStart("error",s);fputs(",\"reason\":",stdout);escaped(reason);eventEnd();}
static char *base64(const char *bytes,int n){ DWORD size=0; CryptBinaryToStringA((const BYTE*)bytes,n,CRYPT_STRING_BASE64|CRYPT_STRING_NOCRLF,NULL,&size); char *p=calloc(1,size+1); if(p)CryptBinaryToStringA((const BYTE*)bytes,n,CRYPT_STRING_BASE64|CRYPT_STRING_NOCRLF,p,&size); return p; }
static char *unbase64(const char *text,int *size){DWORD n=0;if(!CryptStringToBinaryA(text,0,CRYPT_STRING_BASE64,NULL,&n,NULL,NULL))return NULL;char *p=calloc(1,n+1);if(!p||!CryptStringToBinaryA(text,0,CRYPT_STRING_BASE64,(BYTE*)p,&n,NULL,NULL)){free(p);return NULL;}*size=n;return p;}
/* Inputs are bounded flat JSON emitted by the trusted main process. Strings are
 * decoded rather than interpolated into commands; SDP and media use base64. */
static const char *field(const char *json,const char *key){char name[100];snprintf(name,sizeof(name),"\"%s\"",key);const char*p=strstr(json,name);if(!p)return NULL;p+=strlen(name);while(*p==' '||*p=='\t')p++;if(*p++!=':')return NULL;while(*p==' '||*p=='\t')p++;return p;}
static char *stringValue(const char*p,const char**end){if(!p||*p++!='"')return NULL;char*out=malloc(strlen(p)+1),*w=out;if(!out)return NULL;while(*p&&*p!='"'){char c=*p++;if(c=='\\'){c=*p++;if(c=='n')c='\n';else if(c=='r')c='\r';else if(c=='t')c='\t';else if(c!='"'&&c!='\\'&&c!='/'){free(out);return NULL;}}*w++=c;}if(*p!='"'){free(out);return NULL;}*w=0;if(end)*end=p+1;return out;}
static char *getString(const char*j,const char*k){return stringValue(field(j,k),NULL);}
static int flag(const char*j,const char*k,int fallback){const char*p=field(j,k);return p?(strncmp(p,"true",4)==0):fallback;}
static uint64_t number(const char*j,const char*k){const char*p=field(j,k);return p?_strtoui64(p,NULL,10):0;}
static void description(int pc,const char*sdp,const char*type,void*ptr){(void)pc;Session*s=ptr;if(!s||!s->active)return;char*b=base64(sdp,(int)strlen(sdp));if(!b)return;eventStart("answer",s);fputs(",\"sdp\":",stdout);escaped(b);eventEnd();free(b);(void)type;}
static void candidate(int pc,const char*c,const char*mid,void*ptr){(void)pc;Session*s=ptr;if(!s||!s->active)return;eventStart("candidate",s);fputs(",\"candidate\":",stdout);escaped(c);fputs(",\"mid\":",stdout);escaped(mid);eventEnd();}
static void state(int pc,int value,void*ptr){(void)pc;Session*s=ptr;if(!s||!s->active)return;eventStart("state",s);printf(",\"state\":%d",value);eventEnd();}
static void keyframe(int track,void*ptr){(void)track;Session*s=ptr;if(!s||!s->active)return;eventStart("feedback",s);fputs(",\"keyframe\":true",stdout);eventEnd();}
static void logMessage(int level,const char*message){(void)level;(void)message;/* Do not expose SDP/ICE credentials in library logs. */}
static void *intercept(int pc,const char*message,int size,void*ptr){
 (void)pc; Session*s=ptr;const unsigned char*b=(const unsigned char*)message;
 if(s&&s->active&&size>=4){for(int p=0;p+4<=size;){int n=(((int)b[p+2]<<8)|b[p+3])*4+4;if(n<4||p+n>size)break;int fmt=b[p]&31,pt=b[p+1];
  if(pt==206&&fmt==15&&n>=20&&!memcmp(b+p+12,"REMB",4)){unsigned exp=b[p+17]>>2;uint64_t mant=((uint64_t)(b[p+17]&3)<<16)|((unsigned)b[p+18]<<8)|b[p+19];uint64_t rate=exp<44?mant<<exp:UINT64_MAX;eventStart("feedback",s);printf(",\"bitrate\":%llu",(unsigned long long)rate);eventEnd();}
  if(pt==201&&n>=32){unsigned source=((unsigned)b[p+8]<<24)|((unsigned)b[p+9]<<16)|((unsigned)b[p+10]<<8)|b[p+11];unsigned seq=((unsigned)b[p+16]<<24)|((unsigned)b[p+17]<<16)|((unsigned)b[p+18]<<8)|b[p+19];eventStart("feedback",s);printf(",\"kind\":\"%s\",\"reportSequence\":%u,\"fractionLost\":%u,\"jitter\":%u",source==(uint32_t)(0x52430000+s->pc*2)?"video":"audio",seq,b[p+12],((unsigned)b[p+20]<<24)|((unsigned)b[p+21]<<16)|((unsigned)b[p+22]<<8)|b[p+23]);eventEnd();}
  p+=n;
 }}return rtcCreateOpaqueMessage((void*)message,size);
}
static Session *find(const char*id){if(!id)return NULL;for(int i=0;i<64;i++)if(sessions[i].active&&!strcmp(sessions[i].id,id))return &sessions[i];return NULL;}
static void closeSession(Session*s){if(!s||!InterlockedExchange(&s->active,0))return;rtcClosePeerConnection(s->pc);if(s->video>0)rtcDeleteTrack(s->video);if(s->audio>0)rtcDeleteTrack(s->audio);rtcDeletePeerConnection(s->pc);eventStart("closed",s);eventEnd();s->pc=s->video=s->audio=0;}
static int setupTrack(Session*s,int pt,const char*mid,const char*profile,int audio){
 uint32_t ssrc=(uint32_t)(0x52430000+s->pc*2+audio);TrackInit init={0};init.direction=1;init.codec=audio?128:0;init.payloadType=pt;init.ssrc=ssrc;init.mid=mid;init.name="roomcast-native";init.msid="roomcast-native";init.trackId=audio?"audio":"video";init.profile=profile;
 int tr=rtcAddTrackEx(s->pc,&init);if(tr<0)return tr;rtcSetUserPointer(tr,s);PacketizerInit p={0};p.ssrc=ssrc;p.cname="roomcast-native";p.payloadType=(uint8_t)pt;p.clockRate=audio?48000:90000;p.sequenceNumber=1000;p.maxFragmentSize=1200;p.nalSeparator=3;
 int rc=audio?rtcSetOpusPacketizer(tr,&p):rtcSetH264Packetizer(tr,&p);if(rc<0||rtcChainRtcpSrReporter(tr)<0||rtcChainRtcpNackResponder(tr,audio?128:1024)<0){rtcDeleteTrack(tr);return -1;}
 if(!audio){rtcChainPliHandler(tr,keyframe);rtcSetOpenCallback(tr,keyframe);}return tr;
}
static const char *sdpLine(const char *text,const char *prefix){
 size_t n=strlen(prefix);for(const char*p=text;p&&*p;){if(!strncmp(p,prefix,n))return p;const char*end=strchr(p,'\n');p=end?end+1:NULL;}return NULL;
}
/* Fmtp values cannot spill into the next PT or m-section. */
static int fmtpValue(const char*line,const char*key,char*out,size_t capacity){
 size_t keySize=strlen(key);const char*end=line+strcspn(line,"\r\n");
 for(const char*p=line;p<end;){while(p<end&&(*p==' '||*p=='\t'||*p==';'))p++;const char*next=memchr(p,';',(size_t)(end-p));if(!next)next=end;
  if((size_t)(next-p)>keySize&& !_strnicmp(p,key,keySize)&&p[keySize]=='='){const char*v=p+keySize+1;while(next>v&&(next[-1]==' '||next[-1]=='\t'))next--;size_t n=(size_t)(next-v);if(n>=capacity)return 0;memcpy(out,v,n);out[n]=0;return 1;}p=next;
 }return 0;
}
static int validHighLevel(unsigned level){switch(level){case 9:case 10:case 11:case 12:case 13:case 20:case 21:case 22:case 30:case 31:case 32:case 40:case 41:case 42:case 50:case 51:case 52:case 60:case 61:case 62:return 1;default:return 0;}}
static unsigned levelRank(unsigned level){return level==9?105:level*10;}
/* SDP codec/mid selection is scoped to each m-section, never global PT order.
 * Match the actual encoder SPS, not the maximum preset or the offered level.
 * Level asymmetry does not permit exceeding the offerer's receive level. */
static int media(const char*sdp,const char*kind,char*mid,int midSize,char*profile,int profileSize,const char*localProfile){
 unsigned encoded=0;char trailing;if(!strcmp(kind,"video")&&(!localProfile||strlen(localProfile)!=6||sscanf(localProfile,"%6x%c",&encoded,&trailing)!=1||(encoded>>8)!=0x6400||!validHighLevel(encoded&255)))return -1;
 char marker[40];snprintf(marker,sizeof(marker),"m=%s ",kind);const char*start=sdpLine(sdp,marker);if(!start)return -1;const char*end=strstr(start+2,"\nm=");size_t n=end?(size_t)(end-start):strlen(start);char*section=malloc(n+1);if(!section)return -1;memcpy(section,start,n);section[n]=0;
 int port=0,formats=0;sscanf(section,"m=%*s %d %*s %n",&port,&formats);
 if(!formats||(!port&&!sdpLine(section,"a=bundle-only"))||sdpLine(section,"a=inactive")||sdpLine(section,"a=sendonly")){free(section);return -1;}
 const char*m=sdpLine(section,"a=mid:");if(!m||sscanf(m,"a=mid:%31s",mid)!=1){free(section);return -1;}mid[midSize-1]=0;int chosen=-1;
 for(const char*p=section;(p=sdpLine(p,"a=rtpmap:"));p++){int pt;char codec[80];if(sscanf(p,"a=rtpmap:%d %79s",&pt,codec)!=2||pt<0||pt>127)continue;
  int listed=0;for(const char*f=section+formats;*f&&*f!='\r'&&*f!='\n';){char*after;long value=strtol(f,&after,10);if(after==f)break;if(value==pt)listed=1;f=after;while(*f==' '||*f=='\t')f++;}if(!listed)continue;
  if(!strcmp(kind,"audio")){if(!_stricmp(codec,"opus/48000/2")){chosen=pt;break;}continue;}
  if(_stricmp(codec,"H264/90000"))continue;
  char fmtp[40];snprintf(fmtp,sizeof(fmtp),"a=fmtp:%d ",pt);const char*f=sdpLine(section,fmtp);if(!f)continue;f+=strlen(fmtp);
  char mode[8],six[8],maximum[8],asymmetry[8];unsigned value=0,maxValue=0;char extra;
  if(!fmtpValue(f,"packetization-mode",mode,sizeof(mode))||strcmp(mode,"1")||!fmtpValue(f,"profile-level-id",six,sizeof(six))||strlen(six)!=6||sscanf(six,"%6x%c",&value,&extra)!=1||(value>>8)!=(encoded>>8)||!validHighLevel(value&255))continue;
  unsigned level=value&255;
  if(fmtpValue(f,"max-recv-level",maximum,sizeof(maximum))&&strlen(maximum)==4&&sscanf(maximum,"%4x%c",&maxValue,&extra)==1&&(maxValue>>8)==0&&validHighLevel(maxValue)&&levelRank(maxValue)>levelRank(level))level=maxValue;
  if(levelRank(level)<levelRank(encoded&255))continue;
  int asymmetric=fmtpValue(f,"level-asymmetry-allowed",asymmetry,sizeof(asymmetry))&&!strcmp(asymmetry,"1");
  /* max-recv-level above the default only applies when asymmetry is allowed. */
  if(levelRank(value&255)<levelRank(encoded&255)&&!asymmetric)continue;
  snprintf(profile,profileSize,"profile-level-id=%06x;packetization-mode=1;level-asymmetry-allowed=%d",encoded,asymmetric);chosen=pt;break;
 }free(section);return chosen;
}
static void create(const char*j){char*id=getString(j,"id"),*offer=getString(j,"offer");if(!id||strlen(id)>=96||!offer){free(id);free(offer);errorEvent(NULL,"invalid-create");return;}if(find(id)){free(id);free(offer);errorEvent(NULL,"duplicate-id");return;}Session*s=NULL;for(int i=0;i<64;i++)if(!sessions[i].active&&!sessions[i].pc){s=&sessions[i];break;}if(!s){free(id);free(offer);errorEvent(NULL,"session-limit");return;}memset(s,0,sizeof(*s));strcpy(s->id,id);int n=0;char*sdp=unbase64(offer,&n);free(id);free(offer);if(!sdp){errorEvent(s,"invalid-offer");return;}
 char *servers[32]={0};int count=0;const char*p=field(j,"iceServers");if(p&&*p++=='['){while(*p&&*p!=']'&&count<32){while(*p==' '||*p==','||*p=='\t')p++;if(*p==']')break;servers[count]=stringValue(p,&p);if(!servers[count])break;count++;}}
 Configuration cfg={0};cfg.iceServers=(const char**)servers;cfg.iceServersCount=count;cfg.disableAutoNegotiation=true;cfg.forceMediaTransport=true;cfg.iceTransportPolicy=flag(j,"relay",0)?1:0;cfg.mtu=1280;
 s->pc=rtcCreatePeerConnection(&cfg);for(int i=0;i<count;i++)free(servers[i]);if(s->pc<0){s->pc=0;free(sdp);errorEvent(s,"create-peer-failed");return;}s->active=1;s->keyframe=1;rtcSetUserPointer(s->pc,s);rtcSetLocalDescriptionCallback(s->pc,description);rtcSetLocalCandidateCallback(s->pc,candidate);rtcSetStateChangeCallback(s->pc,state);rtcSetMediaInterceptorCallback(s->pc,intercept);
 char*localProfile=getString(j,"profileLevelId");char mid[32]={0},profile[200]={0};int pt=media(sdp,"video",mid,sizeof(mid),profile,sizeof(profile),localProfile);free(localProfile);if(flag(j,"video",1)&&pt>=0)s->video=setupTrack(s,pt,mid,profile,0);memset(mid,0,sizeof(mid));pt=media(sdp,"audio",mid,sizeof(mid),profile,sizeof(profile),NULL);if(flag(j,"audio",1)&&pt>=0)s->audio=setupTrack(s,pt,mid,NULL,1);
 if(s->video<=0||(flag(j,"audio",1)&&s->audio<=0)||rtcSetRemoteDescription(s->pc,sdp,"offer")<0||rtcSetLocalDescription(s->pc,"answer")<0){errorEvent(s,"negotiate-failed");closeSession(s);}free(sdp);
}
static void sendFrame(const char*j,int audio){char*data=getString(j,"data");if(!data)return;int size=0;char*bytes=unbase64(data,&size);free(data);if(!bytes||size<=0){free(bytes);return;}uint64_t pts=number(j,"ptsUs");int isKey=flag(j,"keyframe",0);uint32_t ts=(uint32_t)((pts/1000)*(audio?48:90)+(pts%1000)*(audio?48:90)/1000);uint64_t now=GetTickCount64();
 for(int i=0;i<64;i++){Session*s=&sessions[i];int tr=audio?s->audio:s->video;if(!s->active||tr<=0||!rtcIsOpen(tr))continue;if(!audio&&s->keyframe){if(!isKey)continue;s->keyframe=0;}rtcSetTrackRtpTimestamp(tr,ts);if(now-s->lastSr>=1000){if(s->video>0)rtcSetNeedsToSendRtcpSr(s->video);if(s->audio>0)rtcSetNeedsToSendRtcpSr(s->audio);s->lastSr=now;}if(rtcSendMessage(tr,bytes,size)<0)errorEvent(s,"send-failed");}free(bytes);
}
static void command(const char*j){char*cmd=getString(j,"cmd");if(!cmd)return;if(!strcmp(cmd,"create"))create(j);else if(!strcmp(cmd,"video"))sendFrame(j,0);else if(!strcmp(cmd,"audio"))sendFrame(j,1);else {char*id=getString(j,"id");Session*s=find(id);if(!strcmp(cmd,"close")){if(s)closeSession(s);}else if(!strcmp(cmd,"candidate")&&s){char*c=getString(j,"candidate"),*m=getString(j,"mid");if(c&&m&&rtcAddRemoteCandidate(s->pc,c,m)<0)errorEvent(s,"candidate-failed");free(c);free(m);}free(id);}free(cmd);}
int wmain(int argc,wchar_t**argv){if(argc!=2)return 2;InitializeCriticalSection(&outputLock);HMODULE dll=LoadLibraryExW(argv[1],NULL,LOAD_WITH_ALTERED_SEARCH_PATH);if(!dll){errorEvent(NULL,"load-datachannel-failed");return 3;}
#define LOAD(name) do { FARPROC proc=GetProcAddress(dll,#name);memcpy(&name,&proc,sizeof(name));if(!name){errorEvent(NULL,"missing-"#name);return 4;} }while(0)
 LOAD(rtcCreatePeerConnection);LOAD(rtcDeletePeerConnection);LOAD(rtcClosePeerConnection);LOAD(rtcSetUserPointer);LOAD(rtcSetLocalDescriptionCallback);LOAD(rtcSetLocalCandidateCallback);LOAD(rtcSetStateChangeCallback);LOAD(rtcSetOpenCallback);LOAD(rtcSetRemoteDescription);LOAD(rtcSetLocalDescription);LOAD(rtcAddRemoteCandidate);LOAD(rtcAddTrackEx);LOAD(rtcDeleteTrack);LOAD(rtcSetH264Packetizer);LOAD(rtcSetOpusPacketizer);LOAD(rtcChainRtcpSrReporter);LOAD(rtcChainRtcpNackResponder);LOAD(rtcChainPliHandler);LOAD(rtcSetTrackRtpTimestamp);LOAD(rtcSetNeedsToSendRtcpSr);LOAD(rtcSendMessage);LOAD(rtcIsOpen);LOAD(rtcSetMediaInterceptorCallback);LOAD(rtcCreateOpaqueMessage);LOAD(rtcInitLogger);LOAD(rtcCleanup);
 rtcInitLogger(0,logMessage);eventStart("ready",NULL);eventEnd();size_t cap=65536,len=0;char*line=malloc(cap);int ch;
 while((ch=getchar())!=EOF){if(ch=='\n'){line[len]=0;command(line);len=0;}else {if(len+1>=cap){if(cap>=12*1024*1024){errorEvent(NULL,"message-limit");break;}cap*=2;char*p=realloc(line,cap);if(!p)break;line=p;}line[len++]=(char)ch;}}
 free(line);for(int i=0;i<64;i++)closeSession(&sessions[i]);rtcCleanup();FreeLibrary(dll);DeleteCriticalSection(&outputLock);return 0;
}



