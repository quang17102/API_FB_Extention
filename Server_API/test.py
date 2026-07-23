import requests

cookies = {
    'datr': 'GM5raCPLMi1AtWaswWHyuiy5',
    'sb': 'GM5raJKyhx5TSxIc9NIbO4V5',
    'ps_l': '1',
    'ps_n': '1',
    'pas': '100006493872918%3Aud1VtVxHTi',
    'c_user': '100006493872918',
    'b_user': '100006493872918',
    'xs': '24%3Aaj9wIm42q4ShjQ%3A2%3A1783067718%3A-1%3A-1%3A%3AAczw7WEHeJDbrcX4Tw9JZs-_pU8dVhAVA8UJ15nqoiie',
    'fr': '1C9rjD3oVQlrK2JxI.AWeG_UKq3QZ-0QxpGgsXnUlG_0cWpoCwLj0jLBRTP5VU7H4JmMo.BqX4Z3..AAA.0.0.BqX4x4.AWdMr1IvIAZ-JRZoRxOwL_9Pf58',
    'wd': '884x911',
    'presence': 'C%7B%22t3%22%3A%5B%5D%2C%22utc3%22%3A1784646992376%2C%22v%22%3A1%7D',
}

headers = {
    'accept': '*/*',
    'accept-language': 'en-US,en;q=0.9',
    'content-type': 'application/x-www-form-urlencoded',
    'origin': 'https://www.facebook.com',
    'priority': 'u=1, i',
    'sec-ch-prefers-color-scheme': 'light',
    'sec-ch-ua': '"Not;A=Brand";v="8", "Chromium";v="150", "Google Chrome";v="150"',
    'sec-ch-ua-full-version-list': '"Not;A=Brand";v="8.0.0.0", "Chromium";v="150.0.7871.129", "Google Chrome";v="150.0.7871.129"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-model': '""',
    'sec-ch-ua-platform': '"Windows"',
    'sec-ch-ua-platform-version': '"15.0.0"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
    'x-fb-friendly-name': 'useLinkSharingCreateWrappedUrlMutation',
}

data = {
    'av': '100006493872918',
    '__aaid': '0',
    '__user': '100006493872918',
    '__a': '1',
    '__req': '15',
    'dpr': '1',
    '__ccg': 'EXCELLENT',
    '__comet_req': '15',
    'fb_dtsg': 'NAfwonBDCjO-SFilPFM16lw1Uw8X99Sc5NipNl1VHBcXdntGFBAkF2g:24:1783067718',
    '__spin_b': 'trunk',
    '__crn': 'comet.fbweb.CometSinglePostDialogRoute',
    'fb_api_caller_class': 'RelayModern',
    'fb_api_req_friendly_name': 'useLinkSharingCreateWrappedUrlMutation',
    'server_timestamps': 'true',
    'variables': '{"input":{"actor_id":"100006493872918","client_mutation_id":"1","original_content_url":"https://www.facebook.com/904352212764888_122131174047177403","product_type":"UNKNOWN_FROM_DEEP_LINK"}}',
    'doc_id': '30568280579452205',
}

response = requests.post('https://www.facebook.com/api/graphql/', cookies=cookies, headers=headers, data=data)
print(response.text)