// Human-authored fixture. No model calls, credentials, external resources or storage.
const posts = [
  { title: '第一次写博客', category: '生活', body: '记录生活里的小发现。' },
  { title: '学习网页制作', category: '学习', body: '从一个简单页面开始理解网页，记录 Web 学习笔记。' },
  { title: '周末散步', category: '生活', body: '观察街道和树木，整理新的想法。' },
];
const container = document.getElementById('posts');
for (const post of posts) {
  const article = document.createElement('article');
  const title = document.createElement('h3'); title.textContent = post.title;
  const category = document.createElement('small'); category.textContent = post.category;
  const body = document.createElement('p'); body.textContent = post.body;
  article.append(title, category, body); container.append(article);
}
