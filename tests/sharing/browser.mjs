import assert from 'node:assert/strict';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {verifyDesktopPublish} from './desktop-publish.mjs';

export async function verifyBrowser({origin,bob,alice,directory,db,projectId}){
  const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];
  page.setDefaultTimeout(15000);
  page.on('pageerror',error=>errors.push(error.message));
  try{
    await page.goto(origin);
    await page.getByLabel('이메일',{exact:true}).fill(bob.email);await page.getByLabel('비밀번호',{exact:true}).fill(bob.password);
    await page.getByRole('button',{name:'로그인',exact:true}).click();await page.getByRole('button',{name:'A',exact:true}).click();
    await page.locator('canvas').waitFor();await page.getByLabel('객체 선택').selectOption('object-1');
    await page.getByRole('button',{name:'선택 객체 첨부',exact:true}).click();await page.getByLabel('검토 의견').fill('웹에서 모델을 확인했습니다.');
    await page.getByRole('button',{name:'의견 보내기',exact:true}).click();await page.getByText('서버에 의견이 접수되었습니다.',{exact:true}).waitFor();
    await page.getByRole('button',{name:'위',exact:true}).click();
    assert.equal(await page.locator('.model-area').getAttribute('data-projection'),'orthographic');
    await page.getByRole('button',{name:'원근',exact:true}).click();
    await page.screenshot({path:join(directory,'sharing-desktop.png'),fullPage:true});
    let lost=false;await page.route('**/comments',async route=>{
      if(!lost&&route.request().method()==='POST'){lost=true;await route.fetch();await route.abort();}else await route.continue();
    });
    await page.getByLabel('검토 의견').fill('응답 유실 후에도 의견은 하나입니다.');await page.getByRole('button',{name:'의견 보내기',exact:true}).click();
    await page.getByRole('button',{name:'같은 의견 접수 확인',exact:true}).waitFor();
    await page.reload();await page.getByRole('button',{name:'같은 의견 접수 확인',exact:true}).waitFor();
    assert.equal(await page.getByLabel('검토 의견').isDisabled(),true);
    await page.getByRole('button',{name:'같은 의견 접수 확인',exact:true}).click();await page.getByText('서버에 의견이 접수되었습니다.',{exact:true}).waitFor();
    const row=await db.prepare("SELECT count(*) n FROM comments WHERE project_id=? AND json_extract(payload,'$.body')=?").bind(projectId,'응답 유실 후에도 의견은 하나입니다.').first();assert.equal(row.n,1);
    await page.setViewportSize({width:390,height:844});await page.locator('canvas').waitFor();
    await page.waitForFunction(()=>document.querySelector('canvas')?.clientHeight>200);
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    await page.screenshot({path:join(directory,'sharing-mobile.png'),fullPage:true});
    assert.ok((await page.getByRole('button',{name:'A',exact:true}).boundingBox())?.height>=30);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    assert.deepEqual(errors,[]);const published=await verifyDesktopPublish({browser,origin,alice,directory,db,projectId});
    await page.getByLabel('검토 의견').fill('이전 화면의 기준을 유지합니다.');await page.getByRole('button',{name:'의견 보내기',exact:true}).click();
    await page.getByRole('button',{name:'이전 게시본에 의견 보내기',exact:true}).waitFor();assert.equal(await page.getByLabel('검토 의견').inputValue(),'이전 화면의 기준을 유지합니다.');
    return {browserLogin:true,browserModelDisplayed:true,browserComment:true,responseLossReloadIdempotent:true,mobileNoHorizontalOverflow:true,staleBasisWarning:true,...published};
  }finally{await browser.close();}
}
