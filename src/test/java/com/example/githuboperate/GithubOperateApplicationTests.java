package com.example.githuboperate;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

/**
 * 校验应用上下文、接口映射和中文 JSON 响应，测试不连接外部服务。
 */
@SpringBootTest
@AutoConfigureMockMvc
class GithubOperateApplicationTests {

	@Autowired
	private MockMvc mockMvc;

	@Test
	void shouldReturnGreetingWithTeam() throws Exception {
		mockMvc.perform(get("/api/greeting"))
				.andExpect(status().isOk())
				.andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_JSON))
				.andExpect(jsonPath("$.message").value("欢迎学习 Git 分支合并！"))
				.andExpect(jsonPath("$.team").value("后端团队"));
	}

}
