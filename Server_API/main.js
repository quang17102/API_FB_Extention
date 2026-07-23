import { createFacebookBusinessClient } from "facebook-business"

const cookie = "datr=GM5raCPLMi1AtWaswWHyuiy5; sb=GM5raJKyhx5TSxIc9NIbO4V5; ps_l=1; ps_n=1; pas=100006493872918%3Aud1VtVxHTi; c_user=100006493872918; b_user=100006493872918; xs=24%3Aaj9wIm42q4ShjQ%3A2%3A1783067718%3A-1%3A-1%3A%3AAczw7WEHeJDbrcX4Tw9JZs-_pU8dVhAVA8UJ15nqoiie; fr=1C9rjD3oVQlrK2JxI.AWcEqczoGgOaFJjKPedSk1fc-EmeMF5ay80_Ecq05O2TDs3sdHs.BqX4Z3..AAA.0.0.BqX5CS.AWcR12PNTE_OS799sIvss1wVETc; wd=752x911; presence=C%7B%22lm3%22%3A%22sc.24673965292216855%22%2C%22t3%22%3A%5B%7B%22o%22%3A0%2C%22i%22%3A%22sc.24673965292216855%22%7D%5D%2C%22utc3%22%3A1784647925883%2C%22v%22%3A1%7D"
const pageId = "904352212764888"

const facebook = createFacebookBusinessClient({
  cookie: cookie,
  graphVersion: "v24.0",
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
})

// const pageAccessToken = "EAAGNO4a7r2wBSPOW4tJUGcPmqZBWG25886KHIBjFgHfYJZA2wLgrXsSN1lCa3835dRYiv11Fzw4ZCeQAtBlIuzBzZAAWk4ZCZCY4tIZABley3T47ixIZCxQaGrlxq6XOugYou9lRxZBGj6FiAXH9QFhjVaf1qyYvZCLOc2h8eeVHZClkLuCWMAWiSYgqJCsi4TYy0w4sSZA87AZDZD"

const pageAccessToken = await facebook.getPageToken({
    pageId: pageId,
  })
console.log(pageAccessToken)

const pagePost = await facebook.createPagePost({
    pageId: pageId,
    accessToken: pageAccessToken || undefined,
    message: "Published from a server-side workflow.",
    attachmentType: "none",
  })

console.log(pagePost)